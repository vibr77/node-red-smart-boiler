/*
 * smart-boiler 0.82 test suite.
 * Runs on a fake clock with a fake Node-RED runtime and an in-memory MQTT broker
 * (see test/helpers/fake-red.js). Run with: npm test
 */
'use strict';
const assert = require('assert');
const sinon = require('sinon');
const H = require('./helpers/fake-red');
const B = H.BOILER;

const START = Date.parse('2026-10-29T20:00:00+01:00');
let clock, RED, nodes;

function load(settings = {}) {
    delete require.cache[require.resolve('../smart-boiler.js')];
    RED = H.createRED();
    require('../smart-boiler.js')(RED);
    RED.addConfig('bs', Object.assign({ mqttHost: 'broker', mqttPort: 1883, mqttRootPath: 'homeassistant', haDiscovery: false, haBaseTopic: 'smartheating' }, settings));
}
const min = (n) => clock.tick(n * 60000);
const sec = (n) => clock.tick(n * 1000);

function boiler(extra = {}) {
    const b = RED.create('smart-boiler', H.boilerConfig('b1', extra));
    nodes.push(b);
    sec(2);
    return b;
}
// What a smart-valve sends to the boiler.
// What a 0.82 smart-valve sends to the boiler (one room group per name unless given).
const GROUPS = {};
const gid = (name) => GROUPS[name] || (GROUPS[name] = Object.keys(GROUPS).length + 1);
const valve = (b, name, sp, temp, extra = {}) => RED.input(b, { payload: Object.assign({
    command: 'set', target: 'boiler', setpoint: Number(sp).toFixed(2), temperature: Number(temp).toFixed(2),
    requestedBy: name, groupId: gid(name), health: 'OK', reasons: [] }, extra) });
// What a 0.81 smart-valve sends: no health, only on change.
const valve081 = (b, name, sp, temp) => RED.input(b, { payload: {
    command: 'set', target: 'boiler', setpoint: Number(sp).toFixed(2), temperature: Number(temp).toFixed(2),
    requestedBy: name, groupId: gid(name) } });

const last = (topic) => H.broker.last(topic);
const leader = () => { const l = last(B.lead); return l && l.value; };

// Keeps rooms reporting (like 0.82 valves with their 10 min heartbeat).
function keepAlive(b, rooms, minutes) {
    for (let i = 0; i < minutes; i += 10) {
        rooms.forEach(r => valve(b, r[0], r[1], typeof r[2] === 'function' ? r[2](i) : r[2]));
        min(10);
    }
}

describe('smart-boiler 0.82', function () {
    this.timeout(60000);      // long simulated periods (12 h, 25 h) on a fake clock; slow disks need more than 2 s
    beforeEach(function () {
        clock = sinon.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        H.resetBroker();
        nodes = [];
        load();
    });
    afterEach(async function () {
        for (const n of nodes) await RED.close(n);
        clock.restore();
    });

    describe('Leader selection and boiler commands', function () {
        it('B-01 follows the room with the largest gap and switches central heating on', function () {
            const b = boiler();
            valve(b, 'LOU', 20, 19.5);
            valve(b, 'PARENT', 21, 19.0);
            assert.strictEqual(leader(), 'PARENT');
            assert.strictEqual(last(B.sp), 21);
            assert.deepStrictEqual(last(B.temp), { value: 19 });
            assert.strictEqual(last(B.ch), 1);
        });

        it('B-02 switches central heating off when no room needs heat', function () {
            const b = boiler();
            valve(b, 'LOU', 20, 21);
            valve(b, 'PARENT', 19, 20.5);
            assert.strictEqual(last(B.ch), 0);
        });

        it('B-03 ties go to the higher setpoint', function () {
            const b = boiler();
            valve(b, 'LOU', 20, 19);
            valve(b, 'ARTHUR', 21, 20);
            assert.strictEqual(leader(), 'ARTHUR');
        });

        it('B-04 caps a setpoint above Max SP', function () {
            const b = boiler({ maxSp: '22' });
            valve(b, 'LOU', 30, 19);
            assert.strictEqual(last(B.sp), 22);
        });

        it('B-05 rejects invalid input without crashing', function () {
            const b = boiler();
            [{}, { payload: {} }, { payload: { command: 'set' } }, { payload: { command: 'set', setpoint: 'x', temperature: 19, requestedBy: 'A', groupId: 1 } },
             { payload: { command: 'override', setpoint: 20 } }].forEach(m => assert.doesNotThrow(() => RED.input(b, m)));
            assert.strictEqual(b.liveStack.length, 0);
        });
    });

    describe('Silent and stale valves', function () {
        it('B-06 a valve that stops reporting is ignored after the valve timeout', function () {
            const b = boiler();
            valve(b, 'CHLOE', 23, 19);                // stuck valve, then silent
            keepAlive(b, [['LOU', 20, 20.5]], 25);
            assert.strictEqual(leader(), 'CHLOE', 'still trusted within 30 min');
            keepAlive(b, [['LOU', 20, 20.5]], 20);
            assert.notStrictEqual(leader(), 'CHLOE');
            assert.strictEqual(last(B.ch), 0, 'no room needs heat once CHLOE is ignored');
        });

        it('B-07 a disabled valve saved in the stack (restart) never drives the boiler (incident regression)', async function () {
            let b = boiler();
            valve(b, 'CHLOE', 23, 19);
            valve(b, 'LOU', 20, 20.5);
            await RED.close(b); nodes = [];
            min(60);                                  // SV_CHLOE disabled meanwhile, Node-RED restarted
            b = boiler();
            keepAlive(b, [['LOU', 20, 20.5]], 30);
            assert.notStrictEqual(leader(), 'CHLOE');
            assert.strictEqual(last(B.ch), 0);
        });

        it('B-08 a valve silent for 24 h is purged from the saved stack', function () {
            const b = boiler({ maxDurationSinceLastInput: '120' });
            valve(b, 'CHLOE', 19, 19);
            keepAlive(b, [['LOU', 20, 20.5]], 25 * 60);
            assert.deepStrictEqual(b.liveStack.map(i => i.name), ['LOU']);
        });

        it('B-09 security mode when nothing reports: defaults sent and central heating off', function () {
            const b = boiler();
            valve(b, 'LOU', 21, 19);
            assert.strictEqual(last(B.ch), 1);
            min(16);
            assert.strictEqual(last(B.ch), 0);
            assert.strictEqual(last(B.sp), 7);
            assert.deepStrictEqual(last(B.temp), { value: 10 });
            assert.deepStrictEqual(last(B.lead), { value: 'Security mode' });
        });

        it('B-10 security mode when every valve is silent even if the global timer is long', function () {
            const b = boiler({ maxDurationSinceLastInput: '600' });
            valve(b, 'LOU', 21, 19);
            min(35);
            assert.strictEqual(last(B.ch), 0);
            assert.deepStrictEqual(last(B.lead), { value: 'Security mode' });
        });
    });

    describe('Unsatisfiable rooms', function () {
        it('B-11 a room leading 3 h without warming up is put on hold and the next room takes over', function () {
            const b = boiler();
            keepAlive(b, [['CHLOE', 23, 19.0], ['LOU', 20, 19.5]], 170);
            assert.strictEqual(leader(), 'CHLOE');
            keepAlive(b, [['CHLOE', 23, 19.0], ['LOU', 20, 19.5]], 20);
            assert.strictEqual(leader(), 'LOU');
            assert.ok(b.holds['group ' + gid('CHLOE')], JSON.stringify(b.holds));
        });

        it('B-12 the hold ends after the hold duration', function () {
            const b = boiler();
            keepAlive(b, [['CHLOE', 23, 19.0], ['LOU', 20, 19.5]], 190);
            assert.strictEqual(leader(), 'LOU');
            keepAlive(b, [['CHLOE', 23, 19.0], ['LOU', 20, 19.5]], 130);
            assert.strictEqual(leader(), 'CHLOE');
        });

        it('B-13 a room that is warming up slowly is never put on hold', function () {
            const b = boiler();
            // +0.1 °C every 10 min = +1.8 °C in 3 h
            keepAlive(b, [['PARENT', 23, (i) => 17 + i / 100]], 360);
            assert.strictEqual(leader(), 'PARENT');
            assert.ok(!b.liveStack[0].heldUntil);
        });

        it('B-14 when every requesting room is on hold, central heating is switched off', function () {
            const b = boiler();
            keepAlive(b, [['CHLOE', 23, 19.0]], 190);
            assert.strictEqual(last(B.ch), 0);
        });

        it('B-15 the check can be disabled (Unsatisfied = 0)', function () {
            const b = boiler({ unsatisfiedTimeout: '0' });
            keepAlive(b, [['CHLOE', 23, 19.0]], 600);
            assert.strictEqual(leader(), 'CHLOE');
        });
    });

    describe('Review fixes (0.82.1)', function () {
        it('B-20 a room just below its setpoint (radiator at full) is never put on hold', function () {
            const b = boiler();
            keepAlive(b, [['PARENT', 20, 19.8]], 8 * 60);
            assert.strictEqual(leader(), 'PARENT');
            assert.strictEqual(last(B.ch), 1);
            assert.deepStrictEqual(b.holds, {});
        });

        it('B-21 the hold timer does not survive a restart', async function () {
            let b = boiler();
            keepAlive(b, [['CHLOE', 21, 18]], 170);
            await RED.close(b); nodes = [];
            b = boiler();
            keepAlive(b, [['CHLOE', 21, 18]], 30);
            assert.strictEqual(last(B.ch), 1, 'still heating 30 min after restart');
            assert.deepStrictEqual(b.holds, {});
        });

        it('B-22 a room with several valves is held as a whole (salon: 4 valves, one sensor)', function () {
            const b = boiler();
            const salon = ['ESCALIER', 'CANAPE', 'PASSERELLE', 'BIBLIO'].map(n => ['SV_SALON_' + n, 21, 18, ]);
            const send = () => salon.forEach(r => valve(b, r[0], r[1], r[2], { groupId: 3 }));
            for (let i = 0; i < 200; i += 10) { send(); min(10); }
            assert.ok(b.holds['group 3']);
            assert.strictEqual(last(B.ch), 0, 'no other salon valve takes over');
        });

        it('B-23 0.81 valves (no heartbeat) are never expired: upgrading only the boiler keeps heating', function () {
            const b = boiler();
            valve081(b, 'OLD_ROOM', 21, 19);                   // quiet: its temperature does not change
            for (let i = 0; i < 12; i++) { valve081(b, 'BUSY_ROOM', 20, 20.5 + (i % 2) / 100); min(10); }
            assert.strictEqual(leader(), 'OLD_ROOM', 'quiet 0.81 room still counted after 2 h');
            assert.strictEqual(last(B.ch), 1);
        });

        it('B-24 every valve silent with Security off: central heating is switched off', function () {
            const b = boiler({ boilerSecurity: false });
            valve(b, 'LOU', 21, 19);
            assert.strictEqual(last(B.ch), 1);
            min(35);
            assert.strictEqual(last(B.ch), 0);
        });

        it('B-25 status detail explains who the boiler heats for and which rooms are ignored', function () {
            load({ haDiscovery: true });
            const b = boiler();
            valve(b, 'CHLOE', 19, 19, { health: 'FAILED', reasons: ['no_ack'], setpoint: '5.00' });
            keepAlive(b, [['PARENT', 21, 19.8], ['LOU', 20, 19.6]], 10);
            let st = JSON.parse(H.broker.retained['smartheating/boiler/rsl_boiler/state']);
            assert.strictEqual(st.status_detail, 'Heating for PARENT: 21.0 °C requested, room 19.8 °C (gap 1.2 °C). Also asking: LOU (0.4 °C). Ignored: CHLOE (valve FAILED: no_ack).');
            keepAlive(b, [['PARENT', 21, 21.2], ['LOU', 20, 20.5]], 30);
            st = JSON.parse(H.broker.retained['smartheating/boiler/rsl_boiler/state']);
            assert.match(st.status_detail, /^No room needs heat, central heating off\. Closest: (LOU|PARENT), room .* Ignored: CHLOE \(silent \d+ min\)\.$/);
            assert.ok(H.broker.retained['homeassistant/sensor/smartboiler_b1/status_detail/config']);
        });
    });

    describe('MQTT queue', function () {
        it('B-16 messages queued before the connection are delivered once connected', function () {
            const b = RED.create('smart-boiler', H.boilerConfig('b1'));
            nodes.push(b);
            valve(b, 'LOU', 21, 19);                  // before the fake broker accepted the connection
            sec(2);
            assert.strictEqual(last(B.ch), 1);
            assert.strictEqual(last(B.sp), 21);
        });
    });

    describe('Home Assistant discovery', function () {
        it('B-17 publishes discovery and a state describing every room', function () {
            load({ haDiscovery: true });
            const b = boiler();
            const uid = 'smartboiler_b1';
            ['sensor/status', 'binary_sensor/demand', 'sensor/leading', 'sensor/requesting', 'sensor/ignored', 'binary_sensor/problem']
                .forEach(e => { const [c, o] = e.split('/'); assert.ok(H.broker.retained[`homeassistant/${c}/${uid}/${o}/config`], 'missing ' + e); });
            assert.strictEqual(H.broker.retained['smartheating/boiler/rsl_boiler/availability'], 'online');
            valve(b, 'CHLOE', 23, 19);
            keepAlive(b, [['LOU', 21, 19.5]], 40);
            const st = JSON.parse(H.broker.retained['smartheating/boiler/rsl_boiler/state']);
            assert.strictEqual(st.status, 'heat');
            assert.strictEqual(st.leading, 'LOU');
            assert.deepStrictEqual(st.requesting, ['LOU']);
            assert.deepStrictEqual(st.ignored, ['CHLOE (silent)']);
        });

        it('B-18 reports security status to Home Assistant', function () {
            load({ haDiscovery: true });
            const b = boiler();
            valve(b, 'LOU', 21, 19);
            min(16);
            const st = JSON.parse(H.broker.retained['smartheating/boiler/rsl_boiler/state']);
            assert.strictEqual(st.status, 'security');
            assert.strictEqual(st.demand, false);
        });

        it('B-19 publishes nothing for Home Assistant when disabled (default)', function () {
            const b = boiler();
            valve(b, 'LOU', 21, 19);
            assert.ok(!Object.keys(H.broker.retained).some(t => t.startsWith('homeassistant/sensor') || t.startsWith('smartheating/')));
        });
    });

    describe('Remove command and away rooms (0.83)', function () {
        const remove = (b, p) => RED.input(b, { payload: Object.assign({ command: 'remove' }, p) });

        it('B-26 remove by name drops the valve; if it was leading the boiler follows the next room', function () {
            const b = boiler();
            valve(b, 'CHLOE', 23, 19);
            valve(b, 'LOU', 21, 20);
            assert.strictEqual(leader(), 'CHLOE');
            remove(b, { requestedBy: 'CHLOE' });
            assert.deepStrictEqual(b.liveStack.map(i => i.name), ['LOU']);
            assert.strictEqual(leader(), 'LOU');
            assert.strictEqual(last(B.sp), 21);
        });

        it('B-27 remove a list of names, a room group, or everything (central heating off)', function () {
            const b = boiler();
            valve(b, 'SALON1', 21, 19, { groupId: 9 });
            valve(b, 'SALON2', 21, 19, { groupId: 9 });
            valve(b, 'LOU', 20, 19.5);
            valve(b, 'PARENT', 19, 18);
            remove(b, { groupId: 9 });
            assert.deepStrictEqual(b.liveStack.map(i => i.name), ['LOU', 'PARENT']);
            remove(b, { requestedBy: ['LOU'] });
            assert.deepStrictEqual(b.liveStack.map(i => i.name), ['PARENT']);
            remove(b, { all: true });
            assert.strictEqual(b.liveStack.length, 0);
            assert.strictEqual(last(B.ch), 0);
        });

        it('B-28 the removal is saved; a valve still running comes back with its next message', async function () {
            let b = boiler();
            valve(b, 'CHLOE', 23, 19);
            valve(b, 'LOU', 21, 20);
            remove(b, { requestedBy: 'CHLOE' });
            await RED.close(b); nodes = [];
            b = boiler();
            assert.deepStrictEqual(b.liveStack.map(i => i.name), ['LOU']);
            valve(b, 'CHLOE', 23, 19);
            assert.deepStrictEqual(b.liveStack.map(i => i.name).sort(), ['CHLOE', 'LOU']);
        });

        it('B-29 an incomplete or unknown remove does not crash nor change the stack', function () {
            const b = boiler();
            valve(b, 'LOU', 21, 20);
            assert.doesNotThrow(() => remove(b, {}));
            assert.doesNotThrow(() => remove(b, { requestedBy: 'NOBODY' }));
            assert.deepStrictEqual(b.liveStack.map(i => i.name), ['LOU']);
        });

        it('B-30 an away room only drives the boiler below its frost setpoint and is listed in Home Assistant', function () {
            load({ haDiscovery: true });
            const b = boiler();
            assert.ok(H.broker.retained['homeassistant/sensor/smartboiler_b1/away/config']);
            valve(b, 'LOU', 7, 12, { away: true });
            valve(b, 'PARENT', 19, 20);
            assert.strictEqual(last(B.ch), 0, 'away room warm enough: no heat');
            let st = JSON.parse(H.broker.retained['smartheating/boiler/rsl_boiler/state']);
            assert.deepStrictEqual(st.away, ['LOU']);
            assert.match(st.status_detail, /Away \(frost protection only\): LOU 7\.0 °C/);
            valve(b, 'LOU', 7, 6, { away: true });
            assert.strictEqual(leader(), 'LOU', 'frost protection');
            assert.strictEqual(last(B.ch), 1);
        });
    });
});

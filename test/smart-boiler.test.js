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
const valve = (b, name, sp, temp, extra = {}) => RED.input(b, { payload: Object.assign({
    command: 'set', target: 'boiler', setpoint: Number(sp).toFixed(2), temperature: Number(temp).toFixed(2),
    requestedBy: name, groupId: 1 }, extra) });

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
            assert.ok(b.liveStack.find(i => i.name === 'CHLOE').heldUntil);
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
});

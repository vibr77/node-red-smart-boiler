
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.82.1
  \ V / | || _ \   /      Date: 20261030
   \_/ |___|___/_|_\      Description: Nodered Heating Boiler Management
                2026      Licence: Creative Commons
______________________
*/ 

/* TEST Env
npm install ./modulename (SmartValve / SmartBoiler / SmartSchedule)
node-red -v -D logging.console.level=trace
// Web http://localhost:1880/

Deploy to npmjs
npm publish

*/

var moment = require('moment'); // require
const mqtt = require("mqtt");
const fs = require('fs');
const path = require('path');
const pjson = require('./package.json');

// Terminal command  node-red -v -D logging.console.level=trace

module.exports = function (RED) {
    
    function SmartBoiler(n) {
        RED.nodes.createNode(this, n)
        
        this.name = n.name
        this.mqttclient=null;
        this.boilerEntityID=n.boilerEntityID;                                           
        this.boilerCurrentTemperatureSetTopic=n.boilerCurrentTemperatureSetTopic;                         // MQTT Topic to update the boiler current temperature
        this.boilerCurrentTemperatureKey=n.boilerCurrentTemperatureKey; 
        
        this.boilerSpSetTopic=n.boilerSpSetTopic;
        this.boilerSpKey=n.boilerSpKey;

        this.boilerLeadingDeviceSetTopic=n.boilerLeadingDeviceSetTopic;
        this.boilerLeadingDeviceIdSetTopic=n.boilerLeadingDeviceIdSetTopic;
        this.boilerLeadingDeviceKey=n.boilerLeadingDeviceKey;

        this.boilerSwCentralHeatingSetTopic=n.boilerSwCentralHeatingSetTopic;
        this.boilerSwCentralHeatingKey=n.boilerSwCentralHeatingKey;

        
            // Key in the JSON payload for the current temperature
        //this.boilerSpTopic=n.boilerSpTopic;                             // MQTT Topic to update the boiler set point temperature
        //this.boilerSwCentralHeatingTopic=n.boilerSwCentralHeatingTopic;
        //this.boilerLeadingDeviceTopic=n.boilerLeadingDeviceTopic;       // MQTT Topic to update the boiler Leading Device Topic (Text)
        //this.boilerLeadingDeviceIdTopic=n.boilerLeadingDeviceIdTopic;  
        this.mqttUpdates=n.mqttUpdates;                                 // Send MQTT updates
        this.outputUpdates=n.outputUpdates;                             // Send updates to output
        this.triggerMode = n.triggerMode ? n.triggerMode : 'trigger.statechange.startup' // output / mqtt update mode
        this.cycleDuration=n.cycleDuration ? n.cycleDuration : 60;      // Update cycle duration to be sent to boiler
        this.defaultSp=n.defaultSp ? n.defaultSp :5;                    // Default boiler set point if no update received in the given timeframe (maxDurationSinceLastInput)
        this.defaultTemp=n.defaultTemp ? n.defaultTemp :10;             // Default boiler current temperature if no update received in the given timeframe (maxDurationSinceLastInput)
        this.maxDurationSinceLastInput=n.maxDurationSinceLastInput ? n.maxDurationSinceLastInput : 5; // Important to avoid the Boiler to continue to heat endlessly, expressed in min
        
        this.lastInputTs=moment();                                      // Timestamp of the last input msg received
        this.debugInfo=n.debugInfo ? n.debugInfo:false                  // boolean flag to trigger debug information to the console.
        this.mqttSettings = RED.nodes.getNode(n.mqttSettings);          // MQTT connexion settings
        this.boilerSecurity=n.boilerSecurity?n.boilerSecurity:false;    // send security msg after max duration period

        // --- Hardening (0.82) ---------------------------------------------------------------
        // itemMaxAge: minutes after which a valve that stopped reporting is ignored (0 = off).
        //             Needs smart-valve >= 0.82 (heartbeat) so quiet but healthy rooms keep refreshing.
        // maxSp:      hard ceiling on any setpoint accepted from a valve.
        // purgeAfter: hours after which a silent valve is removed from the persisted stack.
        this.itemMaxAge=(n.itemMaxAge!==undefined && n.itemMaxAge!=="" && !isNaN(n.itemMaxAge)) ? parseInt(n.itemMaxAge) : 30;
        this.maxSp=(n.maxSp!==undefined && n.maxSp!=="" && !isNaN(n.maxSp)) ? parseFloat(n.maxSp) : 25;
        this.purgeAfter=24;
        // unsatisfiedTimeout: minutes a room may lead the boiler without warming up by minRise °C before it is
        //                     put on hold for unsatisfiedHold minutes (0 = off). Catches a room the boiler cannot
        //                     satisfy (stuck valve, open window, wrong sensor) that would otherwise heat all night.
        this.unsatisfiedTimeout=(n.unsatisfiedTimeout!==undefined && n.unsatisfiedTimeout!=="" && !isNaN(n.unsatisfiedTimeout)) ? parseInt(n.unsatisfiedTimeout) : 180;
        this.unsatisfiedHold=(n.unsatisfiedHold!==undefined && n.unsatisfiedHold!=="" && !isNaN(n.unsatisfiedHold)) ? parseInt(n.unsatisfiedHold) : 120;
        this.minRise=(n.minRise!==undefined && n.minRise!=="" && !isNaN(n.minRise)) ? parseFloat(n.minRise) : 0.3;
        this.holdGap=0.5;                  // °C: the hold timer only runs while the room is further than this below its setpoint
        this.holds={};                     // room group -> time its hold ends (memory only: a restart starts clean)
        this.leadTimer=undefined;          // {key, since, startTemp, sp} of the room currently leading
        this.lastHaPayload=undefined;
        this.lastHaPublishTs=0;
        
        this.liveStack=[];                                              // Stack of valve information 
        this.mqttstack=[];                                              // Stack of MQTT msg to be sent 
        
        this.msgStormMsgCounter=0;
        this.msgStormMaxMsg=n.msgStormMaxMsg ? parseInt(n.msgStormMaxMsg): 20;
        this.debugInfo=n.debugInfo? n.debugInfo :"debug";                                                 // debug verbose to the console
        this.msgStormInterval=10000; // 10 seconde
        this.msgStormLastTs=0;

        const node = this;

        // Initialize context storage for persistence
     
       

        node.activeItem=undefined;                                       // Current Active Valve as reference for the boiler sp>temp
        node.previousItem=undefined;                                     // Item of the stack sent to the boiler
        node.previousActiveItemSp=undefined;                             // Previous SP to detect changes even if gap is constant
        node.activeItemGap=-99;                                          // Current active item gap (initialized to -99)
        node.previousActiveItemGap=undefined;                            // Previous gap for change detection


        node.manualTrigger=true;

        node.status({
            fill:  'yellow',
            shape: 'dot',
            text:("Waiting for data...")
        });  

        this.ev=function(){
            node.manualTrigger=true;
            evaluate();
        }

        function nlog(msg, level="debug"){
            const levels = {
                "none": 0,
                "error": 1,
                "warn": 2,
                "info": 3,
                "debug": 4
            };
            const currentLevel = levels[node.debugInfo] || 0;
            const msgLevel = levels[level] || 4;

            if (msgLevel <= currentLevel){
                if (level === "error") {
                    node.error(msg);
                } else if (level === "warn") {
                    node.warn(msg);
                } else {
                    node.log(msg);
                    // Also send to warn if it was previously doing so for debug visibility in sidebar
                    // The original code did node.log AND node.warn for debugInfo=true
                    if (level === "debug" || level === "info") {
                         node.warn(msg); 
                    }
                }
            }
        }

        function saveState() {
            const state = {
                liveStack: node.liveStack,
                activeItem: node.activeItem,
                previousItem: node.previousItem,
                previousActiveItemSp: node.previousActiveItemSp,
                activeItemGap: node.activeItemGap,
                previousActiveItemGap: node.previousActiveItemGap,
                lastInputTs: node.lastInputTs ? node.lastInputTs.toISOString() : null,
                timestamp: Date.now()
            };
            
            // Save to both context and file system
            node.context().set("boilerState", state);
            
            // Save to file for persistence across deploys
            const stateDir = path.join(RED.settings.userDir, '.node-red-state');
            const stateFile = path.join(stateDir, `boiler-${node.id}.json`);
            
            try {
                if (!fs.existsSync(stateDir)) {
                    fs.mkdirSync(stateDir, { recursive: true });
                }
                fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
                nlog("State saved to file: " + node.liveStack.length + " items in stack", "debug");
            } catch (err) {
                nlog("Error saving state to file: " + err.message, "error");
            }
        }

        // Load saved state at startup
        let savedState = null;
        
        // Try to load from file first (persists across deploys)
        const stateDir = path.join(RED.settings.userDir, '.node-red-state');
        const stateFile = path.join(stateDir, `boiler-${node.id}.json`);
        
        try {
            if (fs.existsSync(stateFile)) {
                const fileData = fs.readFileSync(stateFile, 'utf8');
                savedState = JSON.parse(fileData);
                nlog("Loaded state from file", "info");
            }
        } catch (err) {
            nlog("Error loading state from file: " + err.message, "warn");
        }
        
        // Fallback to context storage if file doesn't exist
        if (!savedState) {
            savedState = node.context().get("boilerState");
            if (savedState) {
                nlog("Loaded state from context", "info");
            }
        }
        
        if (savedState) {
            node.liveStack = (savedState.liveStack || []).map(function(it){
                delete it.leadSince; delete it.leadStartTemp; delete it.heldUntil; delete it.legacy;   // runtime only
                return it;
            });
            node.activeItem = savedState.activeItem;
            node.previousItem = savedState.previousItem;
            node.previousActiveItemSp = savedState.previousActiveItemSp;
            node.activeItemGap = savedState.activeItemGap !== undefined ? savedState.activeItemGap : -99;
            node.previousActiveItemGap = savedState.previousActiveItemGap;
            if (savedState.lastInputTs) {
                node.lastInputTs = moment(savedState.lastInputTs);
            }
            nlog("Loaded saved state: " + node.liveStack.length + " items in stack", "info");
        }

        function sendMqtt(){
            // Send MQTT msg back on the node.livestack

            if (node.mqttclient==null || node.mqttclient.connected!=true){
                if (!node.mqttErrorLogged) nlog("MQTT not connected, messages queued","debug");
                return;
            }

            let msg=node.mqttstack.shift();
            
            while (msg!==undefined){
                nlog('MQTT-> msg dequeueing');
               
                if (msg.topic===undefined || msg.payload===undefined){
                    msg=node.mqttstack.shift();      // skip invalid entry, keep flushing the rest
                    continue;
                }
                
                try {
                    let msgstr;
                    if (typeof msg.payload === 'object') {
                        msgstr = JSON.stringify(msg.payload);
                    } else {
                        msgstr = msg.payload.toString();
                    }
                    nlog("Publishing to topic: "+msg.topic+", payload: "+msgstr,"debug");
                    node.mqttclient.publish(msg.topic.toString(),msgstr,{ qos: msg.qos, retain: msg.retain },(error) => {
                        if (error) {
                            node.error("mqtt error: "+error)
                        }
                    });
                } catch (e) {
                    node.error("Error stringifying MQTT payload: " + e.message);
                }
                msg=node.mqttstack.shift(); 
            }
        };

        function processInput (msg){
            // Processing input msg
            // Expected structure of the incomming msg {sp: int, temp: int, name:text}

            let bFound=false;                           // is the item exist in the stack
            let now = moment();                 
            
            node.lastInputTs=now;
            let sp=parseFloat(parseFloat(msg.setpoint).toFixed(2));
            if (sp>node.maxSp){
                nlog(`Setpoint ${sp}°C from ${msg.requestedBy} above maxSp ${node.maxSp}°C, clamped`,"warn");
                sp=node.maxSp;
            }
            //let adjustedTemp=Math.round(parseFloat(msg.temperature)); // <--- test ongoing

            let adjustedTemp=parseFloat(parseFloat(msg.temperature).toFixed(2));
            //let groupId=parseInt(msg.groupId)
            node.liveStack.forEach(function(item){
                if (item.id==msg.requestedBy){                   // item is found in the stack
                    bFound=true;
                    item.health=msg.health;
                    item.reasons=msg.reasons;
                    item.legacy=(msg.health===undefined);       // a 0.81 valve: no heartbeat, never expired
                    item.sp=sp;
                    item.groupId=msg.groupId;
                    item.temp=adjustedTemp;
                    item.lastupdate= now.toISOString(); // last update timestamp of the item
                }
            });

            if (bFound==false){                         // Not found add to the stack
                let newItem={};
                newItem.id=msg.requestedBy;
                newItem.name=msg.requestedBy;
                newItem.sp=sp;
                newItem.temp=adjustedTemp;
                newItem.groupId=msg.groupId;
                newItem.health=msg.health;
                newItem.reasons=msg.reasons;
                newItem.legacy=(msg.health===undefined);
                newItem.lastupdate= now.toISOString();
                node.liveStack.push(newItem);
            }
            
            evaluate();                                 // Evaluate change straight away
            saveState();                                // Save state after processing input
            return;
        }
        function keyed(key,value){
            if (key && key.trim()!=""){
                let o={}; o[key]=value; return o;
            }
            return value;
        }

        function stackCentralHeating(on){
            if (node.boilerSwCentralHeatingSetTopic===undefined || node.boilerSwCentralHeatingSetTopic==""){
                return;
            }
            node.mqttstack.push({topic:node.boilerSwCentralHeatingSetTopic,payload:keyed(node.boilerSwCentralHeatingKey,on?1:0),qos:0,retain:false});
        }

        function isFresh(item,now){
            if (node.itemMaxAge<=0 || item.lastupdate===undefined) return true;
            if (item.legacy===true) return true;           // 0.81 valves only send on change
            return Math.abs(moment(item.lastupdate).diff(now,"m"))<node.itemMaxAge;
        }

        function securityMode(reason, haStatus){
            if (node.outputUpdates==true){
                let msg={};
                msg.payload={temperature:node.defaultTemp,setpoint:node.defaultSp,name:"Security mode"};
                node.send([msg,null]);
            }

            if (node.mqttUpdates==true){
                stackCentralHeating(false);
                if (node.boilerSpSetTopic) node.mqttstack.push({topic:node.boilerSpSetTopic,payload:keyed(node.boilerSpKey,parseFloat(parseFloat(node.defaultSp).toFixed(2))),qos:0,retain:false});
                if (node.boilerCurrentTemperatureSetTopic) node.mqttstack.push({topic:node.boilerCurrentTemperatureSetTopic,payload:keyed(node.boilerCurrentTemperatureKey,parseFloat(parseFloat(node.defaultTemp).toFixed(2))),qos:0,retain:false});
                if (node.boilerLeadingDeviceSetTopic) node.mqttstack.push({topic:node.boilerLeadingDeviceSetTopic,payload:keyed(node.boilerLeadingDeviceKey,"Security mode"),qos:0,retain:false});
                if (node.boilerLeadingDeviceIdSetTopic) node.mqttstack.push({topic:node.boilerLeadingDeviceIdSetTopic,payload:keyed(node.boilerLeadingDeviceKey,0),qos:0,retain:false});
                sendMqtt();
            }

            node.activeItem=undefined;
            node.activeItemGap=-99;

            node.status({
                fill:  'yellow',
                shape: 'ring',
                text:(reason+", t:"+node.defaultTemp+"°C, sp:"+node.defaultSp+"°C")
            });
            publishHaState(moment(), node.liveStack.filter(function(it){ return isFresh(it,moment()); }), haStatus||'security');
        }

        function groupKey(it){
            return (it.groupId!==undefined && it.groupId!==null && String(it.groupId)!=='') ? 'group '+it.groupId : it.name;
        }
        function isHeld(it,now){
            let u=node.holds[groupKey(it)];
            return u!==undefined && moment(u).isAfter(now);
        }

        function selectLeader(list){
            // The room with the largest gap (sp - temp) leads; ties go to the higher setpoint.
            let best={item:undefined,gap:-99};
            list.forEach(function(item){
                let g=parseFloat(item.sp)-parseFloat(item.temp);
                if (isNaN(g)) return;
                if (g>best.gap || (g==best.gap && best.item!==undefined && parseFloat(best.item.sp)<parseFloat(item.sp))){
                    best={item:item,gap:g};
                }
            });
            return best;
        }

        // ---- Home Assistant discovery -------------------------------------------------------
        const ha = {
            enabled: !!(node.mqttSettings && (node.mqttSettings.haDiscovery===true || node.mqttSettings.haDiscovery==='true')),
            prefix: (node.mqttSettings && node.mqttSettings.mqttRootPath) ? node.mqttSettings.mqttRootPath : 'homeassistant',
            base: (node.mqttSettings && node.mqttSettings.haBaseTopic) ? node.mqttSettings.haBaseTopic : 'smartheating'
        };
        const haSlug = String(node.name||'boiler').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'') || 'boiler';
        const haUid = 'smartboiler_'+String(node.id).replace(/[^a-zA-Z0-9]/g,'');
        const haStateTopic = `${ha.base}/boiler/${haSlug}/state`;
        const haAvailTopic = `${ha.base}/boiler/${haSlug}/availability`;
        node.haAvailTopic=haAvailTopic;
        node.haEnabled=ha.enabled;

        function publishHaDiscovery(){
            if (!ha.enabled) return;
            const device={identifiers:[haUid],name:`SmartBoiler ${node.name}`,manufacturer:'vib',model:'smart-boiler',sw_version:pjson.version};
            const common={state_topic:haStateTopic,availability_topic:haAvailTopic,json_attributes_topic:haStateTopic,device:device};
            [
                ['sensor','status',{name:'Status',unique_id:haUid+'_status',value_template:'{{ value_json.status }}',icon:'mdi:water-boiler'}],
                ['binary_sensor','demand',{name:'Heat demand',unique_id:haUid+'_demand',device_class:'heat',value_template:"{{ 'ON' if value_json.demand else 'OFF' }}"}],
                ['sensor','leading',{name:'Leading room',unique_id:haUid+'_leading',value_template:'{{ value_json.leading }}',icon:'mdi:radiator'}],
                ['sensor','requesting',{name:'Rooms requesting heat',unique_id:haUid+'_requesting',value_template:'{{ value_json.requesting | count }}',icon:'mdi:home-thermometer'}],
                ['sensor','ignored',{name:'Rooms ignored',unique_id:haUid+'_ignored',value_template:'{{ value_json.ignored | count }}',icon:'mdi:alert'}],
                ['binary_sensor','problem',{name:'Problem',unique_id:haUid+'_problem',device_class:'problem',value_template:"{{ 'ON' if (value_json.ignored | count) > 0 or value_json.status == 'security' else 'OFF' }}"}],
                ['sensor','status_detail',{name:'Status detail',unique_id:haUid+'_status_detail',icon:'mdi:information-outline',value_template:'{{ value_json.status_detail[:255] }}'}]
            ].forEach(function(e){
                node.mqttstack.push({topic:`${ha.prefix}/${e[0]}/${haUid}/${e[1]}/config`,payload:Object.assign(e[2],common),qos:1,retain:true});
            });
            node.mqttstack.push({topic:haAvailTopic,payload:'online',qos:1,retain:true});
        }

        // Plain-language explanation of what the boiler does and why.
        function boilerDetail(st,rooms,now){
            const t=v=>(v===undefined||v===null||isNaN(v))?'?':parseFloat(v).toFixed(1)+' °C';
            const age=r=>r.last_update?Math.round(Math.abs(moment(r.last_update).diff(now,'m'))):'?';
            const why=function(r){
                if (r.state==='silent') return `${r.name} (silent ${age(r)} min)`;
                if (r.state==='on_hold') return `${r.name} (on hold until ${moment(r.held_until).format('HH:mm')}: did not warm up)`;
                if (r.state==='failed') return `${r.name} (valve FAILED: ${(r.reasons||[]).join(', ')||'?'})`;
                return r.name;
            };
            let head;
            if (st.status==='heat'){
                let lead=rooms.find(function(r){ return r.name===st.leading; });
                head=`Heating for ${st.leading}: ${t(st.setpoint)} requested, room ${t(st.temperature)}`+(lead?` (gap ${lead.gap.toFixed(1)} °C).`:'.');
                let others=rooms.filter(function(r){ return r.state==='ok' && r.gap>0 && r.name!==st.leading; }).map(function(r){ return `${r.name} (${r.gap.toFixed(1)} °C)`; });
                if (others.length) head+=' Also asking: '+others.join(', ')+'.';
            } else if (st.status==='idle'){
                let ok=rooms.filter(function(r){ return r.state==='ok'; }).sort(function(a,b){ return b.gap-a.gap; });
                head='No room needs heat, central heating off.'+(ok.length?` Closest: ${ok[0].name}, room ${t(ok[0].temperature)} for ${t(ok[0].setpoint)}.`:'');
            } else if (st.status==='security'){
                head=`Security mode: no credible valve report, central heating off and default ${t(node.defaultSp)} sent.`;
            } else {
                head='No valve has reported recently, central heating off.';
            }
            let ignored=rooms.filter(function(r){ return r.state!=='ok'; });
            if (ignored.length) head+=' Ignored: '+ignored.map(why).join(', ')+'.';
            return head;
        }

        function publishHaState(now,freshStack,status){
            if (!ha.enabled) return;
            freshStack=freshStack||[];
            let rooms=node.liveStack.map(function(it){
                let fresh=freshStack.includes(it);
                let held=isHeld(it,now);
                let state= !fresh ? 'silent' : (held ? 'on_hold' : (it.health==='FAILED' ? 'failed' : 'ok'));
                return {name:it.name,setpoint:parseFloat(it.sp),temperature:parseFloat(it.temp),gap:parseFloat((parseFloat(it.sp)-parseFloat(it.temp)).toFixed(2)),state:state,health:it.health||null,reasons:it.reasons||[],held_until:held?node.holds[groupKey(it)]:null,last_update:it.lastupdate};
            });
            let demand = status ? false : (node.activeItem!==undefined && node.activeItemGap>0);
            let st={
                status: status ? status : (demand ? 'heat' : 'idle'),
                demand: demand,
                leading: (!status && node.activeItem) ? node.activeItem.name : null,
                setpoint: (!status && node.activeItem) ? parseFloat(node.activeItem.sp) : parseFloat(node.defaultSp),
                temperature: (!status && node.activeItem) ? parseFloat(node.activeItem.temp) : parseFloat(node.defaultTemp),
                requesting: rooms.filter(function(r){ return r.state==='ok' && r.gap>0; }).map(function(r){ return r.name; }),
                ignored: rooms.filter(function(r){ return r.state!=='ok'; }).map(function(r){ return r.name+' ('+r.state+')'; }),
                rooms: rooms
            };
            st.status_detail=boilerDetail(st,rooms,now);
            let cmp=JSON.stringify(Object.assign({},st,{rooms:rooms.map(function(r){ return [r.name,r.state,r.setpoint,r.temperature]; })}));
            let nowMs=moment(now).valueOf();
            if (cmp!==node.lastHaPayload || nowMs-node.lastHaPublishTs>=5*60000){
                node.mqttstack.push({topic:haStateTopic,payload:st,qos:0,retain:true});
                node.lastHaPayload=cmp;
                node.lastHaPublishTs=nowMs;
                sendMqtt();
            }
        }

        function stackMqttMsg(){

            //nlog("stackMqttMsg for activeItem:"+JSON.stringify(node.activeItem));
                    
            if (node.boilerSpSetTopic!=undefined && node.boilerSpSetTopic.trim()!=""){
                let payload = {};
                if (node.boilerSpKey && node.boilerSpKey.trim()!="") {
                    payload[node.boilerSpKey] = parseFloat(parseFloat(node.activeItem.sp).toFixed(2));
                } else {
                    payload = parseFloat(parseFloat(node.activeItem.sp).toFixed(2));
                }
                let mqttmsg={topic:node.boilerSpSetTopic,payload:payload,qos:0,retain:false};
                node.mqttstack.push(mqttmsg);
            }else{
                nlog("boilerSpSetTopic undefined, cannot send setpoint","warn");
            }

            if (node.boilerCurrentTemperatureSetTopic!=undefined && node.boilerCurrentTemperatureSetTopic.trim()!=""){
                let payload = {};
                if (node.boilerCurrentTemperatureKey && node.boilerCurrentTemperatureKey.trim()!="") {
                    payload[node.boilerCurrentTemperatureKey] = parseFloat(parseFloat(node.activeItem.temp).toFixed(2));
                } else {
                    payload = parseFloat(parseFloat(node.activeItem.temp).toFixed(2));
                }

                let mqttmsg={topic:node.boilerCurrentTemperatureSetTopic,payload:payload,qos:0,retain:false};
                node.mqttstack.push(mqttmsg);
            }else{
                nlog("boilerCurrentTemperatureSetTopic undefined, cannot send current temperature","warn");
            }

            if (node.boilerLeadingDeviceSetTopic!=undefined && node.boilerLeadingDeviceSetTopic.trim()!=""){
                let payload = {};
                if (node.boilerLeadingDeviceKey && node.boilerLeadingDeviceKey.trim()!="") {
                    payload[node.boilerLeadingDeviceKey] = node.activeItem.name;
                } else {
                    payload = node.activeItem.name;
                }

                let mqttmsg={topic:node.boilerLeadingDeviceSetTopic,payload:payload,qos:0,retain:false};
                node.mqttstack.push(mqttmsg);
            }else{
                nlog("boilerLeadingDeviceSetTopic undefined, cannot send Leading Device","warn");
            }

            if (node.boilerLeadingDeviceIdSetTopic!=undefined && node.boilerLeadingDeviceIdSetTopic.trim()!="" && node.activeItem!=undefined && node.activeItem.id!=undefined){
                let payload = {};
                if (node.boilerLeadingDeviceKey && node.boilerLeadingDeviceKey.trim()!=""){
                    payload[node.boilerLeadingDeviceKey] = parseInt(node.activeItem.groupId);
                } else {
                    payload = parseInt(node.activeItem.groupId);
                }

                let mqttmsg={topic:node.boilerLeadingDeviceIdSetTopic,payload:payload,qos:0,retain:false};
                node.mqttstack.push(mqttmsg);
            }else{
                nlog("boilerLeadingDeviceIdSetTopic undefined, cannot send Leading Device ID","warn");
            }
        }

        function evaluate(){

             node.msgStormMsgCounter+=1;
            
            if (moment().diff(node.msgStormLastTs)>node.msgStormInterval){
                node.msgStormMsgCounter=1;
            }
            node.msgStormLastTs=moment();

            if (node.msgStormMsgCounter>node.msgStormMaxMsg){
                nlog(`<!> Message storm detected: ${node.msgStormMsgCounter} messages within ${node.msgStormInterval/1000}s, evaluate() aborted!`,"error");
                return;
            }

            let bUpdate=false;                          // state is updated ?
            let bFoundActiveValve=false;                // activeValve (Sp>Temp) is found ?
                            
            let now = moment();
            let diff=node.lastInputTs.diff(now,"m");

            // Max Duration since last input exceeded, sending security msg if enabled
            // with default sp and temp to avoid the boiler to heat endlessly
            if (node.boilerSecurity==true && Math.abs(diff)>=node.maxDurationSinceLastInput){
                securityMode("No update");
                return;
            }

            // Drop valves silent for more than purgeAfter hours (disabled / deleted nodes, dead devices).
            let before=node.liveStack.length;
            node.liveStack=node.liveStack.filter(function(item){
                return item.lastupdate===undefined || Math.abs(moment(item.lastupdate).diff(now,"h"))<node.purgeAfter;
            });
            if (node.liveStack.length!=before){
                nlog(`Purged ${before-node.liveStack.length} silent valve(s) from the stack`,"warn");
                saveState();
            }

            // Only valves that reported recently take part in the decision.
            let freshStack=node.liveStack.filter(function(item){ return isFresh(item,now); });
            let staleNames=node.liveStack.filter(function(item){ return !isFresh(item,now); }).map(function(i){return i.name;});
            if (staleNames.length>0){
                nlog("Ignoring silent valve(s): "+staleNames.join(", "),"debug");
            }

            if (freshStack.length==0){
                node.leadTimer=undefined;
                if (node.liveStack.length>0 && node.boilerSecurity==true){
                    securityMode("All valves silent");
                } else {
                    // Nothing credible to heat for: never leave central heating on with the last command.
                    if (node.mqttUpdates==true){ stackCentralHeating(false); sendMqtt(); }
                    node.activeItem=undefined; node.activeItemGap=-99;
                    node.status({fill:'yellow',shape:'ring',text:'No valve reporting, central heating off'});
                    publishHaState(now,freshStack,'no_data');
                }
                return;
            }

            nlog(JSON.stringify(node.liveStack),"debug");

            bFoundActiveValve=false;
            
            node.previousActiveItemGap=node.activeItemGap;
            if (node.activeItem) {
                node.previousActiveItemSp=node.activeItem.sp;
            }
            node.previousItem=node.activeItem;

            // Rooms on hold (could not be satisfied) are left out, by room group, until their hold ends.
            Object.keys(node.holds).forEach(function(k){
                if (!moment(node.holds[k]).isAfter(now)){
                    nlog(`${k}: hold ended, back in the decision`,"info");
                    delete node.holds[k];
                }
            });
            let eligible=freshStack.filter(function(item){ return !isHeld(item,now); });
            let pick=selectLeader(eligible);

            // Unsatisfiable demand: the same room leads for unsatisfiedTimeout minutes, clearly below its setpoint
            // (gap above holdGap), without warming up by minRise. The timer restarts when the leading room changes,
            // its setpoint changes or it warms up, and stops when the room gets close to its setpoint.
            if (node.unsatisfiedTimeout>0 && pick.item!==undefined && pick.gap>node.holdGap){
                let it=pick.item, key=groupKey(it), T=node.leadTimer, temp=parseFloat(it.temp), sp=parseFloat(it.sp);
                if (!T || T.key!==key || T.sp!==sp){
                    node.leadTimer={key:key, since:now.valueOf(), startTemp:temp, sp:sp};
                } else if (temp-T.startTemp>=node.minRise){
                    node.leadTimer={key:key, since:now.valueOf(), startTemp:temp, sp:sp};
                } else if (now.valueOf()-T.since>=node.unsatisfiedTimeout*60000){
                    node.holds[key]=moment(now).add(node.unsatisfiedHold,"m").toISOString();
                    nlog(`${key}: asked for heat for ${node.unsatisfiedTimeout} min without warming up (${T.startTemp}°C -> ${temp}°C for ${sp}°C), on hold for ${node.unsatisfiedHold} min`,"warn");
                    node.leadTimer=undefined;
                    eligible=eligible.filter(function(x){ return groupKey(x)!==key; });
                    pick=selectLeader(eligible);
                }
            } else {
                node.leadTimer=undefined;
            }

            if (pick.item===undefined){
                securityMode("All requesting rooms on hold","idle");
                return;
            }
            node.activeItem=pick.item;
            node.activeItemGap=pick.gap;
            
            if(node.previousItem===undefined && node.activeItem!==undefined){
                bUpdate=true;
            }
            else if (node.previousItem!==undefined && node.activeItem!==undefined && node.previousItem.id!=node.activeItem.id){
                bUpdate=true;
            }
            else if (node.previousItem!==undefined && node.previousActiveItemGap!=node.activeItemGap){
                bUpdate=true;
            }
            else if (node.activeItem!==undefined && node.previousActiveItemSp!==undefined && node.activeItem.sp!=node.previousActiveItemSp){
                bUpdate=true;
            }

            if (node.activeItem!==undefined && (bUpdate==true || node.triggerMode=="triggerMode.everyCycle" || node.manualTrigger==true)){

                bFoundActiveValve = node.activeItemGap>0;
                if (node.boilerSwCentralHeatingSetTopic===undefined || node.boilerSwCentralHeatingSetTopic==""){
                    if (bFoundActiveValve) nlog("boilerSwCentralHeatingSetTopic undefined, cannot send ON command","error");
                }else{
                    stackCentralHeating(bFoundActiveValve);
                }
                
                let msg={};
                msg.payload=node.activeItem;
                
                if (node.mqttUpdates==true){
                    stackMqttMsg();
                    sendMqtt();
                }

                if (node.outputUpdates)
                    node.send([msg,null]);
                
                if (bFoundActiveValve==true){
                    node.status({
                        fill:  'red',
                        shape: 'dot',
                        text:("Active:"+node.activeItem.name+", t:"+parseFloat(node.activeItem.temp).toFixed(2)+"°C, sp:"+parseFloat(node.activeItem.sp).toFixed(2)+"°C")
                    });
                }else{
                    node.status({
                        fill:  'green',
                        shape: 'dot',
                        text:("Active:"+node.activeItem.name+", t:"+parseFloat(node.activeItem.temp).toFixed(2)+"°C, sp:"+parseFloat(node.activeItem.sp).toFixed(2)+"°C")
                    });
                }
                nlog("Boiler updated to Item id:"+node.activeItem.id+", name:"+node.activeItem.name+", sp:"+node.activeItem.sp+", temp:"+node.activeItem.temp,"info");
                saveState();  // Save state after successful evaluation update
                node.manualTrigger=false;
            }
            publishHaState(now,freshStack);
        }
        
        // INPUT MESSAGE MGNT
        // Command: set
        // Command: stack
        //
        // ***************************************************************************************

        node.on('input', function(msg) {
            
            if (msg.payload===undefined || msg.payload.command==undefined){
                node.warn("input message is invalid returning","warn");
                return;
            }
  
            if (msg.payload.command=="set"){ // Process new data item
            
                if( msg.payload.setpoint===undefined        || 
                    msg.payload.temperature===undefined     || 
                    msg.payload.requestedBy===undefined            || 
                    msg.payload.groupId===undefined){
                        node.error("input invalid msg.payload:"+JSON.stringify(msg.payload)+", expect {setpoint:int, temperature:int, requestedBy:text, groupId:int}","error");
                        return;
                }
                                
                if( isNaN(parseFloat(msg.payload.setpoint)) || isNaN(parseFloat(msg.payload.temperature))){
                    node.error("invalid format for setpoint or temperature, expect numeric values","error");
                    return;
                }

                if( isNaN(msg.payload.setpoint) || isNaN(msg.payload.temperature) || isNaN(msg.payload.groupId)){
                    node.error("invalid input msg format expect temperature, setpoint, id to be number","error");
                    return;
                } 
                
                processInput(msg.payload);
            }

            else if (msg.payload.command=="trigger"){
                let msg={};

                stackMqttMsg();  
                sendMqtt();
            }
            else if (msg.payload.command=="stack"){ // output the current stack
                
                let msg={};

                msg.payload=node.liveStack;
                node.send([msg,null]);
            }else{
                node.warn("Boiler: unknown command in the input msg.payload");
            }  
        });

       
        if (node.mqttUpdates==true && node.mqttSettings && node.mqttSettings.mqttHost){
            
            const protocol = 'mqtt'
            const host = node.mqttSettings.mqttHost
            const port = node.mqttSettings.mqttPort
            const clientId=`smb_${Math.random().toString(16).slice(3)}`;
            const connectUrl = `${protocol}://${host}:${port}`
           
            node.mqttclient = mqtt.connect(connectUrl, {
                clientId,
                clean: true,
                keepalive:60,
                connectTimeout: 4000,
                username: node.mqttSettings.mqttUser,
                password: node.mqttSettings.mqttPassword,
                reconnectPeriod: 5000,
                will: ha.enabled ? {topic:haAvailTopic,payload:'offline',qos:1,retain:true} : undefined,
            });

            node.mqttclient.on('error', function (error) {
                if (!node.mqttErrorLogged){                  // once per outage, not every retry
                    node.warn("MQTT error: "+error+" (will keep retrying, logged once)");
                    node.mqttErrorLogged=true;
                }
            });
        
            node.mqttclient.on('connect', () => {
                if (node.mqttErrorLogged) node.log('MQTT connected again');
                node.mqttErrorLogged=false;
                nlog('MQTT connected', "debug");
                publishHaDiscovery();
                sendMqtt();
            });
        }

        node.evalInterval = setInterval(evaluate, node.cycleDuration*1000);
        
        if (node.triggerMode != 'triggerMode.statechange') {
            node.startTimeout = setTimeout(evaluate, 1000)
        }

         node.on('close', function(done) {
            nlog("closing connexion");
            node.log('MQTT disconnecting');
            clearInterval(node.evalInterval);
            clearTimeout(node.startTimeout);
            if (node.mqttclient) {
                if (ha.enabled && node.mqttclient.connected){
                    node.mqttclient.publish(haAvailTopic,'offline',{qos:1,retain:true});
                }
                node.mqttclient.end();
            }
            done();

        })
        }
    RED.nodes.registerType('smart-boiler', SmartBoiler);

    RED.httpAdmin.post("/smartboiler/:id", RED.auth.needsPermission("inject.write"), function(req,res) {
        var node = RED.nodes.getNode(req.params.id);
        if (node != null) {
            try {
                node.ev();
                res.sendStatus(200);
            } catch(err) {
                res.sendStatus(500);
                node.error(RED._("inject.failed",{error:err.toString()}));
            }
        } else {
            res.sendStatus(404);
        }
    });
  }

   
  

/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.80
  \ V / | || _ \   /      Date: 20251201
   \_/ |___|___/_|_\      Description: Nodered Heating Boiler Management
                2025      Licence: Creative Commons
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
            node.liveStack = savedState.liveStack || [];
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
                node.warn("MQTT not connected...");
                return;
            }

            let msg=node.mqttstack.shift();
            
            while (msg!==undefined){
                nlog('MQTT-> msg dequeueing');
               
                if (msg.topic===undefined || msg.payload===undefined)
                    return;
                
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
            //let adjustedTemp=Math.round(parseFloat(msg.temperature)); // <--- test ongoing

            let adjustedTemp=parseFloat(parseFloat(msg.temperature).toFixed(2));
            //let groupId=parseInt(msg.groupId)
            node.liveStack.forEach(function(item){
                if (item.id==msg.requestedBy){                   // item is found in the stack
                    bFound=true;
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
                newItem.lastupdate= now.toISOString();
                node.liveStack.push(newItem);
            }
            
            evaluate();                                 // Evaluate change straight away
            saveState();                                // Save state after processing input
            return;
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

                
                if (node.outputUpdates==true){
                    let msg={};
                    msg.payload={temperature:node.defaultTemp,setpoint:node.defaultSp,name:"Security mode"};
                    node.send([msg,null]);
                }

                if (node.mqttUpdates==true){
                    let mqttmsg={topic:node.boilerSpSetTopic,payload:parseFloat(parseFloat(node.defaultSp).toFixed(2)),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    let payload = {};
                    payload[node.boilerCurrentTemperatureKey] = parseFloat(parseFloat(node.defaultTemp).toFixed(2));
                    mqttmsg={topic:node.boilerCurrentTemperatureSetTopic,payload:payload,qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                    
                    payload = {};
                    payload[node.boilerLeadingDeviceKey] = "Security mode";
                    mqttmsg={topic:node.boilerLeadingDeviceSetTopic,payload:payload,qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    payload = {};
                    payload[node.boilerLeadingDeviceKey] = 0;
                    mqttmsg={topic:node.boilerLeadingDeviceIdSetTopic,payload:payload,qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                     
                    sendMqtt();
                }

                node.status({
                    fill:  'yellow',
                    shape: 'dot',
                    text:("No update, t:"+node.defaultTemp+"°C, sp:"+node.defaultSp+"°C")
                });    

                return;
            }
            
            nlog(JSON.stringify(node.liveStack),"debug");

            bFoundActiveValve=false;
            
            node.previousActiveItemGap=node.activeItemGap;
            if (node.activeItem) {
                node.previousActiveItemSp=node.activeItem.sp;
            }
            node.activeItemGap=-99;
            
            node.previousItem=node.activeItem;
           
            
            node.liveStack.forEach(function(item){
                // For each item in the stack,
                // if the set point > current temp then the Valve is active
                // select the valve where the Gap is the higher
                // if there is no active valve, select the valve (passive) with the highest sp

                // node.activeItem equal to the active valve to be sent to the boiler
                // node.passiveItem equal to the passive valve in case there is no activeItem

                let itemGap=parseFloat(item.sp)-parseFloat(item.temp);
                //nlog("id:"+item.id+" itemGap:"+itemGap);
                if (itemGap>node.activeItemGap){
                    node.activeItemGap=itemGap;
                    node.activeItem=item;
                     
                }else if (itemGap==node.activeItemGap && node.activeItem!==undefined && node.activeItem.sp<item.sp){
                    node.activeItemGap=itemGap;
                    node.activeItem=item;
                    //nlog("become activeItem:"+item.id);
                }
                nlog("previous Gap:"+node.previousActiveItemGap+", Gap:"+itemGap+", active Item:"+item.id,"debug");
            });

            
            if(node.previousItem===undefined && node.activeItem!==undefined){
                bUpdate=true;
            }
            else if (node.previousItem!==undefined && node.previousItem.id!=node.activeItem.id){
                bUpdate=true;
            }
            else if (node.previousItem!==undefined && node.previousActiveItemGap!=node.activeItemGap){
                bUpdate=true;
            }
            else if (node.activeItem!==undefined && node.previousActiveItemSp!==undefined && node.activeItem.sp!=node.previousActiveItemSp){
                bUpdate=true;
            }

            if (node.activeItem!==undefined && (bUpdate==true || node.triggerMode=="triggerMode.everyCycle" || node.manualTrigger==true)){

                if (node.activeItemGap>0){
                    bFoundActiveValve=true;
                    if (node.boilerSwCentralHeatingSetTopic===undefined || node.boilerSwCentralHeatingSetTopic==""){
                        nlog("boilerSwCentralHeatingSetTopic undefined, cannot send ON command","error");
                        
                    }else{
                        let payload = 1;
                        if (node.boilerSwCentralHeatingKey) {
                            let obj = {};
                            obj[node.boilerSwCentralHeatingKey] = 1;
                            payload = obj;
                        }
                        let mqttmsg={topic:node.boilerSwCentralHeatingSetTopic,payload:payload,qos:0,retain:false};
                        node.mqttstack.push(mqttmsg);
                    }
                } else {
                    if (node.boilerSwCentralHeatingSetTopic===undefined || node.boilerSwCentralHeatingSetTopic==""){
                        // ignore
                    }else{
                        let payload = 0;
                        if (node.boilerSwCentralHeatingKey) {
                            let obj = {};
                            obj[node.boilerSwCentralHeatingKey] = 0;
                            payload = obj;
                        }
                        let mqttmsg={topic:node.boilerSwCentralHeatingSetTopic,payload:payload,qos:0,retain:false};
                        node.mqttstack.push(mqttmsg);
                    }
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
                reconnectPeriod: 1000,
            });

            node.mqttclient.on('error', function (error) {
                node.warn("MQTT error: "+error);
            });
        
            node.mqttclient.on('connect', () => {

                let msg=node.mqttstack.shift();
            
                while (msg!==undefined){
                    nlog('MQTT Connected -> start dequeuing'); 
                    if (msg.topic===undefined || msg.payload===undefined)
                        return;
                    node.mqttclient.publish(msg.topic,JSON.stringify(msg.payload),{ qos: msg.qos, retain: msg.retain },(error) => {
                        if (error) {
                            node.error(error)
                        }
                    });
                    
                    msg=node.mqttstack.shift();
                }
            });
        }

        node.evalInterval = setInterval(evaluate, node.cycleDuration*1000);
        
        if (node.triggerMode != 'triggerMode.statechange') {
            setTimeout(evaluate, 1000)
        }

         node.on('close', function(done) {
            nlog("closing connexion");
            node.log('MQTT disconnecting');
            clearInterval(node.evalInterval);
            if (node.mqttclient) {
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

   
  
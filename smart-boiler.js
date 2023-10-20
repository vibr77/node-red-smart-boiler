
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.66
  \ V / | || _ \   /      Date: 20231010
   \_/ |___|___/_|_\      Description: Nodered Heating Boiler Management
                2023      Licence: Creative Commons
______________________
*/ 

/*
TODO:
-----

*/

var moment = require('moment'); // require
const mqtt = require("mqtt");
var pjson = require('./package.json');


module.exports = function (RED) {
    
    function SmartBoiler(n) {
      RED.nodes.createNode(this, n)
        this.name = n.name
        this.mqttclient=null;
        this.mqttstack=[];                                              // Stack of MQTT message to be sent
        this.boilerTempTopic=n.boilerTempTopic;                         // MQTT Topic to update the boiler current temperature
        this.boilerSpTopic=n.boilerSpTopic;                             // MQTT Topic to update the boiler set point temperature 
        this.boilerLeadingDeviceTopic=n.boilerLeadingDeviceTopic;       // MQTT Topic to update the boiler Leading Device Topic (Text)
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
        
        var node = this;
        
        node.activeItem=undefined;                                       // Current Active Valve as reference for the boiler sp>temp
        node.previousItem=undefined;                                     // Item of the stack sent to the boiler
      
        function nlog(msg){
            
            if (node.debugInfo==true){
                node.log(msg);
            }
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
                let msgstr=JSON.stringify(msg.payload).replace(/\\"/g, '"');
                node.mqttclient.publish(msg.topic.toString(),msgstr,{ qos: msg.qos, retain: msg.retain },(error) => {
                    if (error) {
                        node.error("mqtt error: "+error)
                    }
                });
                msg=node.mqttstack.shift(); 
            }
        };

        function processInput (msg){
            // Processing input msg
            // Expected structure of the incomming msg {sp: int, temp: int, name:text}

            let bFound=false;                           // is the item exist in the stack
            let now = moment();                 
            
            node.lastInputTs=now;
            node.liveStack.forEach(function(item){
                if (item.id==msg.id){                   // item is found in the stack
                    bFound=true;
                    item.sp=msg.setpoint;
                    item.name=msg.name;
                    item.temp=msg.temperature;
                    item.lastupdate= now.toISOString(); // last update timestamp of the item
                }
            });

            if (bFound==false){                         // Not found add to the stack
                let newItem={};
                newItem.id=msg.id;
                newItem.sp=msg.setpoint;
                newItem.temp=msg.temperature;
                newItem.name=msg.name;
                newItem.lastupdate= now.toISOString();
                node.liveStack.push(newItem);
            }
            
            nlog(JSON.stringify(node.liveStack));
            evaluate();                                 // Evaluate change straight away
            return;
        }

        function evaluate(){

            let bUpdate=false;                          // state is updated ?
            let bFoundActiveValve=false;                // activeValve (Sp>Temp) is found ?
                            
            let now = moment();
            let diff=node.lastInputTs.diff(now,"m");

            if (node.boilerSecurity==true && Math.abs(diff)>=node.maxDurationSinceLastInput){

                nlog("maxDurationSinceLastInput exceed, sending security message to the boiler");
                nlog("node.maxDurationSinceLastInput:"+node.maxDurationSinceLastInput+" diff:"+diff);
               
                if (node.outputUpdates==true){
                    let msg={};
                    msg.payload={temperature:node.defaultTemp,setpoint:node.defaultSp,name:"Security mode"};
                    node.send([msg,null]);
                }

                if (node.mqttUpdates==true){
                    mqttmsg={topic:node.boilerSpTopic,payload:parseInt(node.defaultSp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:node.boilerTempTopic,payload:parseInt(node.defaultTemp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:node.boilerLeadingDeviceTopic,payload:{"value":"Security mode"},qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                     
                    sendMqtt();
                }

                node.status({
                    fill:  'red',
                    shape: 'dot',
                    text:("No update, sp: "+node.defaultSp+"°C, temp: "+node.defaultTemp+"°C")
                });    

                return;
            }
            
            nlog(JSON.stringify(node.liveStack));

            bFoundActiveValve=false;
            
            node.previousActiveItemGap=node.activeItemGap;
            node.activeItemGap=-99;
            
            node.previousItem=node.activeItem;
            nlog("node.previousActiveItemGap:"+node.previousActiveItemGap);
            
            node.liveStack.forEach(function(item){
                // For each item in the stack,
                // if the set point > current temp then the Valve is active
                // select the valve where the Gap is the higher
                // if there is no active valve, select the valve (passive) with the highest sp

                // node.activeItem equal to the active valve to be sent to the boiler
                // node.passiveItem equal to the passive valve in case there is no activeItem

                let itemGap=parseFloat(item.sp).toFixed(2)-parseFloat(item.temp).toFixed(2);
                nlog("id:"+item.id+" itemGap:"+itemGap);
                if (itemGap>node.activeItemGap){
                    node.activeItemGap=itemGap;
                    node.activeItem=item;
                }else if (itemGap==node.activeItemGap && node.activeItem.sp<item.sp){
                    node.activeItem=item;
                }
            });

            if(node.previousItem===undefined && node.activeItem!==undefined){
                bUpdate=true;
            }

            if (node.previousItem!==undefined && node.previousItem.id!=node.activeItem.id){
                bUpdate=true;
            }
            else if (node.previousItem!==undefined && node.previousActiveItemGap!=node.activeItemGap){
                bUpdate=true;
            }

            if (node.activeItemGap>0){
                bFoundActiveValve=true;
            }

            nlog("node.activeItemGap:"+node.activeItemGap);
            nlog("bFoundActiveValve:"+bFoundActiveValve);
            nlog("bUpdate:"+bUpdate);

            if (node.activeItem!==undefined && (bUpdate==true || node.triggerMode=="triggerMode.everyCycle")){

                let msg={};
                msg.payload=node.activeItem;
                
                if (node.mqttUpdates==true){
                    
                    mqttmsg={topic:node.boilerSpTopic,payload:parseInt(node.activeItem.sp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:node.boilerTempTopic,payload:parseInt(node.activeItem.temp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                    //let p=JSON.stringify();
                    mqttmsg={topic:node.boilerLeadingDeviceTopic,payload:{value:node.activeItem.name},qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                    
                    sendMqtt();
                }

                if (node.outputUpdates)
                    node.send([msg,null]);
                
                if (bFoundActiveValve==true){
                    node.status({
                        fill:  'red',
                        shape: 'dot',
                        text:("Active:"+node.activeItem.name+", sp: "+node.activeItem.sp+"°C, temp: "+node.activeItem.temp+"°C")
                    });
                }else{
                    node.status({
                        fill:  'blue',
                        shape: 'dot',
                        text:("Active:"+node.activeItem.name+", sp: "+node.activeItem.sp+"°C, temp: "+node.activeItem.temp+"°C")
                    });
                } 
            }
        }

        node.on('input', function(msg) {
            
            if (msg.payload===undefined || 
                (msg.payload.setpoint===undefined     || 
                 msg.payload.temperature===undefined   || 
                 msg.payload.name===undefined   || 
                 msg.payload.id===undefined)){
                    node.error("input msg is invalid expecting msg.payload{setpoint:,temperature:,name:,id}");
                    return;
                 }
            if( isNaN(msg.payload.setpoint) || isNaN(msg.payload.temperature) || isNaN(msg.payload.id)){
                node.error("invalid input msg format expect temperature, setpoint, id to be number");
                    return;
            } 
            processInput(msg.payload);
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

        node.on('close', function() {
            clearInterval(node.evalInterval)
        })

    }
    RED.nodes.registerType('smart-boiler', SmartBoiler);
  }
  
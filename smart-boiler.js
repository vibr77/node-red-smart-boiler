
/*
__   _____ ___ ___        Author: Vincent BESSON
 \ \ / /_ _| _ ) _ \      Release: 0.42
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
const debug=true;

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
        this.lastInputTs=moment();      // Timestamp of the last input msg received
        this.debugInfo=n.debugInfo ? n.debugInfo:false                  // boolean flag to trigger debug information to the console.
        this.mqttSettings = RED.nodes.getNode(n.mqttSettings);          // MQTT connexion settings
        this.liveStack=[];                                              // Stack of valve information 
        
        var node = this;

        node.previousGap=0;                                             // Previous temperature GAP from the temperature and the set point for the activeItem
        node.activeItem=undefined;                                      // Current Active Valve as reference for the boiler sp>temp
        node.passiveItem=undefined;                                     // if no active Valve we need to set a ref to the boiler sp<Temp
        node.previousItem=undefined;                                     // Item of the stack sent to the boiler

        function nlog(msg){
            if (node.debug==true){
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
                let msgstr=JSON.stringify(msg.payload);
                if (msg.topic===undefined || msg.payload===undefined)
                    return;

                node.mqttclient.publish(msg.topic.toString(),JSON.stringify(msg.payload),{ qos: msg.qos, retain: msg.retain },(error) => {
                    if (error) {
                        node.error(error)
                    }
                });
                msg=node.mqttstack.shift(); 
            }
        };

        function processInput (msg){
            // Processing input msg
            // Expected structure of the incomming msg {sp: int, temp: int, name:text}

            let bFound=false;                   // is the item exist in the stack
            let now = moment();                 
            
            node.lastInputTs=now;
            node.liveStack.forEach(function(item){
                if (item.id==msg.id){                   // item is found in the stack
                    bFound=true;
                    item.sp=msg.sp;
                    item.name=msg.name;
                    item.temp=msg.temp;
                    item.lastupdate= now.toISOString(); // last update timestamp of the item
                }
            });

            if (bFound==false){                         // Not found add to the stack
                let newItem={};
                newItem.id=msg.id;
                newItem.sp=msg.sp;
                newItem.temp=msg.temp;
                newItem.name=msg.name;
                newItem.lastupdate= now.toISOString();
                node.liveStack.push(newItem);
            }
            
            n.log(JSON.stringify(node.liveStack));
            return;
        }

        function evaluate(stack){

            let bUpdate=false;                          // state is updated ?
            let bFoundActiveValve=false;                      // activeValve (Sp>Temp) is found ?
            let maxSp=0;                                // Higher Sp of the inactive (passive) Valve

            let now = moment();
            let diff=node.lastInputTs.diff(now,"m");

            n.log("node.maxDurationSinceLastInput:"+node.maxDurationSinceLastInput);
            n.log("diff:"+diff);

            if (Math.abs(diff)>=node.maxDurationSinceLastInput){
                nlog("maxDurationSinceLastInput exceed, sending security message to the boiler")
                if (node.outputUpdates==true){
                    let msg={};
                    msg.payload={temp:node.defaultTemp,sp:node.defaultSp,name:"error security mode"};
                    node.send([msg,null]);
                }

                if (node.mqttUpdates==true){
                    mqttmsg={topic:node.boilerSpTopic,payload:parseInt(node.defaultSp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:node.boilerTempTopic,payload:parseInt(node.defaultTemp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:node.boilerLeadingDeviceTopic,payload:"error security mode",qos:0,retain:false};
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

            node.liveStack.forEach(function(item){
                // For each item in the stack,
                // if the set point > current temp then the Valve is active
                // select the valve where the Gap is the higher
                // if there is no active valve, select the valve (passive) with the highest sp

                // node.activeItem equal to the active valve to be sent to the boiler
                // node.passiveItem equal to the passive valve in case there is no activeItem

                if (parseInt(item.sp)>parseFloat(item.temp)){   // look for valve with set point > current temp
                    
                    bFoundActiveValve=true;
                    if (node.activeItem!==undefined){            // an activeItem exist previously

                        if (node.activeItem!=item){              // Not the same Item 
                            let itemGap=parseFloat(item.sp)-parseFloat(item.temp); // check if the current GAP is higher than the previous Gap to select the valve
                            if (node.previousGap<itemGap){      
                                node.previousGap=itemGap
                                node.activeItem=item;           // A new valve is selected
                                bUpdate=true                    // bUpdate flag is set   
                            }
                        }else{                                  // Same Item 
                            let itemGap=parseFloat(item.sp)-parseFloat(item.temp);
                            node.previousGap=itemGap;           // update the previous gap
                            bUpdate=true;                       // bUpdate fla is set
                        }

                        /*let activeItemGap=parseFloat(node.activeItem.sp)-parseFloat(node.activeItem.temp);
                        let itemGap=parseFloat(item.sp)-parseFloat(item.temp);

                        if (itemGap>activeItemGap){
                            node.activeItem=item;
                            bUpdate=true;
                        }*/
                    }else{
                        let itemGap=parseFloat(item.sp)-parseFloat(item.temp);
                        previousGap=itemGap
                        node.activeItem=item;
                        bUpdate=true;
                    }  
                }else{
                    if (bFoundValve==false){ // we select the biggest SP (not important we need one valve to set the Boiler Sp and Temp)
                        if (item.sp>maxSp){
                            maxSp=item.sp;
                            node.passiveItem=item;
                        }
                    }
                }
            });

            if (bFoundActiveValve==false && node.previousItem!=node.passiveItem){
                bUpdate==true;
            }
            
            if (bFoundValve==true && ( node.triggerMode=="triggerMode.everyCycle" || bUpdate==true)){
                let msg={};
                msg.payload=node.activeItem;
                
                if (node.mqttUpdates==true){
                    
                    mqttmsg={topic:node.boilerSpTopic,payload:parseInt(node.activeItem.sp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:node.boilerTempTopic,payload:parseInt(node.activeItem.temp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:node.boilerLeadingDeviceTopic,payload:node.activeItem.name,qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                    
                    sendMqtt();
                }

                if (node.outputUpdates)
                    node.send([msg,null]);

                node.status({
                    fill:  'green',
                    shape: 'dot',
                    text:("Active:"+node.activeItem.name+", sp: "+node.activeItem.sp+"°C, temp: "+node.activeItem.temp+"°C")
                });  


            }else if (node.passiveItem!==undefined && ( node.triggerMode=="triggerMode.everyCycle" || bUpdate==true)){
                let msg={};
                msg.payload=node.passiveItem;

                if (node.mqttUpdates==true){
                    
                    mqttmsg={topic:node.boilerSpTopic,payload:parseInt(node.passiveItem.sp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:node.boilerTempTopic,payload:parseInt(node.passiveItem.temp),qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);

                    mqttmsg={topic:node.boilerLeadingDeviceTopic,payload:node.passiveItem.name,qos:0,retain:false};
                    node.mqttstack.push(mqttmsg);
                    
                    sendMqtt();
                }

                if (node.outputUpdates)
                    node.send([msg,null]);

                node.status({
                    fill:  'blue',
                     shape: 'dot',
                    text:("Passive:"+node.passiveItem.name+", sp: "+node.passiveItem.sp+"°C, temp: "+node.passiveItem.temp+"°C")
                });

            }else{
                nlog("no item in the stack found");
            }
        }

        node.on('input', function(msg) {
            // <--------- TODO add some control on the input
            //
            if (msg.payload===undefined || 
                (msg.payload.sp===undefined     || 
                 msg.payload.temp===undefined   || 
                 msg.payload.name===undefined   || 
                 msg.payload.id===undefined)){
                    node.warn("input msg is invalid expecting msg.payload{sp:,temp:,name:,id");
                    return;
                 }
            if( isNaN(msg.payload.sp) || isNaN(msg.payload.temp) || isNaN(msg.payload.id)){
                node.warn("invalid input msg format expect temp, sp, id to be number");
                    return;
            } 

            processInput(msg.payload);
    
        });

        if (node.mqttUpdates==true && node.mqttSettings && node.mqttSettings.mqttHost){
            
            const protocol = 'mqtt'
            const host = node.mqttSettings.mqttHost
            const port = node.mqttSettings.mqttPort
            const clientId=`mqtt_${Math.random().toString(16).slice(3)}`;
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
                node.warn("MQTT error:"+error);
            });
        
            node.mqttclient.on('connect', () => {

                
                let msg=node.mqttstack.shift();
            
                while (msg!==undefined){
                    nlog.log('MQTT Connected -> start dequeuing'); 
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

        node.evalInterval = setInterval(evaluate, node.cycleDuration*1000)

        // Run initially directly after start / deploy.
        //if (node.triggerMode != 'triggerMode.statechange') {
        setTimeout(evaluate, 1000)
       // }

       node.on('close', function() {
        clearInterval(node.evalInterval)
    })

    }
    RED.nodes.registerType('smart-boiler', SmartBoiler)
  
  }
  
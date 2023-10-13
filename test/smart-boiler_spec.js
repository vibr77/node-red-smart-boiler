
var should = require("should");
var helper = require("node-red-node-test-helper");
var smartBoilerNode = require("../smart-boiler.js");

var expect = require('chai').expect;
require('mocha-sinon');
//require('debug').enable('*')

helper.init(require.resolve('node-red'));

describe('smartBoiler Node', function () {

  beforeEach(function (done) {
      helper.startServer(done);
  });

  afterEach(function (done) {
      helper.unload();
      helper.stopServer(done);
  });


  it('should modify the flow then lower case of payload', async function () {
    const flow = [
          { id: "n2", type: "helper" }
    ]
    await helper.load(smartBoilerNode, flow)
    const newFlow = [...flow]
    newFlow.push( { id: "n1", type: "smart-boiler", name: "lower-case", wires:[['n2']] },)
    await helper.setFlows(newFlow, "nodes") //update flows
    const n1 = helper.getNode('n1')
    n1.should.have.a.property('name', 'lower-case')
    await new Promise((resolve, reject) => {
      const n2 = helper.getNode('n2')
      n2.on('input', function (msg) {
          try {
              msg.should.have.property('payload', 'hello');
              resolve()
          } catch (err) {
              reject(err);
          }
      });
      n1.receive({ payload: 'HELLO' });
    });
});
  /*it('should be loaded', function (done) {
    var flow = [{ id: "n1", type: "smart-boiler", name: "SmartBoiler Test" }];
    helper.load(smartBoilerNode, flow, function () {
      var n1 = helper.getNode("n1");
      try {
        n1.should.have.property('name', 'SmartBoiler Test');
        done();
      } catch(err) {
        done(err);
      }
    });
  });*/

  /*it('should make payload lower case', function (done) {
    var flow = [
      { id: "n1", type: "smart-boiler", name: "SmartBoiler Test",outputUpdates:true,wires:[["n2"]] },
      { id: "n2", type: "helper" }
    ];

    helper.load(smartBoilerNode, flow, function () {

      var n2 = helper.getNode("n2");
      var n1 = helper.getNode("n1");

      n2.on("input", function (msg) {
        try {
          msg.should.have.property('payload', "sp");
          done();
        } catch(err) {
          done(err);
        }
      });
      n1.receive({ payload: {sp:19,temp:21,name:'test valve 1',id:2} });
    });
  });*//*
  it('should warn if the `somethingGood` prop is falsy', function (done) {
    var flow =  [
       
        {
            "id": "n1",
            "type": "smart-boiler",
            "z": "6055d06465326c04",
            "name": "",
            "topic": "",
            "mqttSettings": "",
            "boilerTempTopic": "",
            "boilerSpTopic": "",
            "boilerLeadingDeviceTopic": "",
            "mqttUpdates": false,
            "debugInfo": false,
            "boilerSecurity": false,
            "triggerMode": "triggerMode.statechange.startup",
            "cycleDuration": 60,
            "outputUpdates": true,
            "defaultSp": 5,
            "defaultTemp": 10,
            "maxDurationSinceLastInput": "5",
            "x": 390,
            "y": 200,
            "wires": [
                []
            ]
        }
    ];
   
    helper.load(smartBoilerNode, flow, function () {

      n1.warn.should.be.calledWithExactly('badness');
      done();
    });
  });
*/
  it('should raised a warn', function (done) {
    var flow =  [
       
      {
          "id": "n1",
          "type": "smart-boiler",
          "z": "6055d06465326c04",
          "name": "",
          "topic": "",
          "mqttSettings": "",
          "boilerTempTopic": "",
          "boilerSpTopic": "",
          "boilerLeadingDeviceTopic": "",
          "mqttUpdates": false,
          "debugInfo": false,
          "boilerSecurity": false,
          "triggerMode": "triggerMode.statechange.startup",
          "cycleDuration": 60,
          "outputUpdates": true,
          "defaultSp": 5,
          "defaultTemp": 10,
          "maxDurationSinceLastInput": "5",
          "x": 390,
          "y": 200,
          "wires": [
              []
          ]
      }
  ];
    helper.load(smartBoilerNode, flow, function () {

      //var n2 = helper.getNode("n2");
      var n1 = helper.getNode("n1");
      /*n1.on('call:warn', call => {
        call.should.be.calledWithExactly('input msg is invalid expecting msg.payload{sp:,temp:,name:,id}');
        done();
      });*/
      n1.on('input', () => {
        n1.warn.should.be.calledWithExactly('input msg is invalid expecting msg.payload{sp:,temp:,name:,id}');
       
        done();
      });

      n1.receive({});
    });
  });
});
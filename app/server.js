var http = require('http'); 
var chalk = require('chalk');
var MqttShepherd = require('mqtt-shepherd');
var _ = require('busyman');

var ioServer = require('./helpers/ioServer');
var server = http.createServer();
var qserver = new MqttShepherd({
  broker: {
    port: 1883
  },
  reqTimeout: 1000 * 50
});

server.listen(3030);
ioServer.start(server);

qserver.start(function (err) {
    if (!err)
        showWelcomeMsg();
    else
        console.log(err);
});

var validGads = [ 'temperature', 'humidity', 'illuminance', 'onOffSwitch', 'buzzer', 'lightCtrl', 'presence', 'dOut' ];

function getDevInfo(clientId) {
    var qnode = qserver.find(clientId);
    if (!qnode)
        return;
    var permAddr = qnode.mac + '#' + qnode.clientId;
    var dumped = qnode.dump(),
        dev = {
            permAddr: permAddr,
            status: qnode.status,
            gads: {}
        };

    validGads.forEach(function (name) {
        if (dumped.so[name]) {
            _.forEach(dumped.so[name], function (gad, iid) {
                var auxId = name + '/' + iid,
                    type = getGadType(name, gad.appType),
                    val = getGadValue(qnode, name, iid);

                dev.gads[auxId] = {
                    type: type,
                    auxId: auxId,
                    value: val
                };
            });
        }
    });

    return dev;
}

var app = function () {
    setLeaveMsg();

    ioServer.regReqHdlr('getDevs', function (args, cb) { 
        // register your req handler, cb(err, data);
        var devs = {},
            recs = qserver.list();

        recs.forEach(function (rec) {
            var dev = getDevInfo(rec.clientId);

            if (!dev)
                return;
            devs[dev.permAddr] = dev;
        });

        setImmediate(function () {
            cb(null, devs);
        });
    });

    ioServer.regReqHdlr('permitJoin', function (args, cb) { 
        // register your req handler
        // cb(err, data);
        //if (!isDemoRunning)
        //    startDemoApp();

        setImmediate(function () {
            //qserver.permitJoin(args.time);
            //qserver.permitJoin(10000);
            cb(null, null);
        });
    });

    ioServer.regReqHdlr('write', function (args, cb) { 
        // args = { permAddr, auxId, value }
        // register your req handler
        // cb(err, data);
        cb(null, false);

        var permSplit = _.split(args.permAddr, '#'),
            auxSplit = _.split(args.auxId, '/'),
            mac = permSplit[0],
            clientId = permSplit[1],
            oid = auxSplit[0],
            iid = auxSplit[1],
            rid = mainResourceName(oid);
        var rscPath = oid + '/' + iid + '/' + rid;
        var qnode = qserver.find(clientId);
        
        if (!qnode)
            setImmediate(function () {
                cb(new Error('Gadget not found.'));
            });
        else
            qnode.writeReq(rscPath, args.value, function (err, rsp) {
                // console.log(err);
                // console.log(rsp);
                cb(err, rsp ? rsp.data : undefined);
            });
    });

    /************************/
    /* Event handle         */
    /************************/
    /*** ready            ***/
    qserver.on('ready', function () {
        readyInd();
        //console.log(qserver.list());
        setImmediate(function () {
            qserver.permitJoin(Number.POSITIVE_INFINITY);
        });
    });

    /*** error            ***/
    qserver.on('error', function (err) {
        errorInd(err.message);
    });

    /*** permitJoining    ***/
    qserver.on('permitJoining', function (joinTimeLeft) {
        permitJoiningInd(joinTimeLeft);
        //console.log(qserver.info())
        //console.log(qserver.list())
    });

    qserver.on('ind', function (msg) {
        var permAddr = msg.qnode ? (msg.qnode.mac + '#' + msg.qnode.clientId) : '';

        if (msg.type === 'devIncoming') {
            /*** devIncoming      ***/
            var devInfo = getDevInfo(msg.qnode.clientId)
            devIncomingInd(devInfo);
        } else if (msg.type === 'devStatus') {
            /*** devStatus        ***/
            devStatusInd(permAddr, msg.data);
            if (msg.qnode.clientId === 'd01')
                startObservingD01(msg.qnode);
            else if (msg.qnode.clientId === 'd02')
                startObservingD02(msg.qnode);
            else if (msg.qnode.clientId === 'd03')
                startObservingD03(msg.qnode);
            else if (msg.qnode.clientId === 'd04')
                startObservingD04(msg.qnode);
        } else if (msg.type === 'devChange') {
            /*** attrsChange      ***/
            var data = msg.data;
            var mainResource = mainResourceName(data.oid);

            if (!data.rid) {
                attrsChangeInd(permAddr, {
                    type: getGadType(data.oid, (data.oid === 'dOut') ? 'flame' : undefined),  // make flame sensor
                    auxId: data.oid + '/' + data.iid,
                    value: data.data[mainResource]
                });
            } else {
                attrsChangeInd(permAddr, {
                    type: getGadType(data.oid, (data.oid === 'dOut') ? 'flame' : undefined),  // make flame sensor
                    auxId: data.oid + '/' + data.iid,
                    value: data.data
                });
            }

            //-- switch detection
            if (msg.qnode.clientId === 'd02' && data.rid === 'dInState') {
                var qnode = qserver.find('d03');
                if (!qnode) return;
                hasSwitchDemoed = true;
                qnode.writeReq('lightCtrl/0/onOff', data.data, function (err, rsp) {
                    // console.log(rsp);
                });
            }

            //-- illum detection
            if (msg.qnode.clientId === 'd01' && data.oid === 'illuminance' && parseInt(data.iid) === 1 && data.rid === 'sensorValue') {
                var qnode = qserver.find('d03');
                if (!qnode) return;
                if (data.data < 50)
                    qnode.writeReq('lightCtrl/0/onOff', 1, function (err, rsp) {
                        // console.log(rsp);
                        setTimeout(function () {
                            qnode.writeReq('lightCtrl/0/onOff', 0, function (err, rsp) {});
                        }, 3000);
                    });
            }

            //-- presence detection
            if (msg.qnode.clientId === 'd04' && data.oid === 'presence' && parseInt(data.iid) === 0 && data.rid === 'dInState') {
                var qnode = qserver.find('d03');
                if (!qnode) return;
                qnode.writeReq('lightCtrl/0/onOff', data.data, function (err, rsp) {
                    // console.log(rsp);
                });
            }

            //-- flame detection
            if (msg.qnode.clientId === 'd04' && data.oid === 'dOut' && parseInt(data.iid) === 0 && data.rid === 'dOutState') {
                var qnode = qserver.find('d03');
                if (!qnode) return;
                qnode.writeReq('buzzer/0/onOff', data.data, function (err, rsp) {
                    // console.log(rsp);
                });
            }
            // data = { type, auxId, value }
        }
    });

    qserver.on("message", function(topic, message, packet) {
      //console.log(topic);
      //console.log(message);
    });

    qserver.on("priphConnected", function(client) {
      //console.log("qserver:priphConnected");
    });

    qserver.on("priphDisconnected", function(client) {
      //console.log("qserver:priphDisconnected");
    });

    qserver.on("priphPublished", function(packet, client) {
      //console.log("qserver:priphPublished");
    });

    qserver.on("priphSubscribed", function(subscriptions, client) {
      //console.log("qserver:priphSubscribed");
    });

    qserver.on("priphUnsubscribed", function(unsubscriptions, client) {
      //console.log("qserver:priphUnsubscribed");
    });
};
/**********************************/
/* welcome function               */
/**********************************/
function showWelcomeMsg() {
    var mqttPart1 = chalk.blue('      __  ___ ____  ______ ______        ____ __ __ ____ ___   __ __ ____ ___   ___ '),
        mqttPart2 = chalk.blue('     /  |/  // __ \\/_  __//_  __/ ____  / __// // // __// _ \\ / // // __// _ \\ / _ \\'),
        mqttPart3 = chalk.blue('    / /|_/ // /_/ / / /    / /   /___/ _\\ \\ / _  // _/ / ___// _  // _/ / , _// // /'),
        mqttPart4 = chalk.blue('   /_/  /_/ \\___\\_\\/_/    /_/         /___//_//_//___//_/   /_//_//___//_/|_|/____/ ');

    console.log('');
    console.log('');
    console.log('Welcome to mqtt-shepherd webapp... ');
    console.log('');
    console.log(mqttPart1);
    console.log(mqttPart2);
    console.log(mqttPart3);
    console.log(mqttPart4);
    console.log(chalk.gray('   A Lightweight MQTT Machine Network Server'));
    console.log('');
    console.log('   >>> Author:     Simen Li (simenkid@gmail.com)');
    console.log('   >>> Version:    mqtt-shepherd v0.6.x');
    console.log('   >>> Document:   https://github.com/lwmqn/mqtt-shepherd');
    console.log('   >>> Copyright (c) 2016 Simen Li, The MIT License (MIT)');
    console.log('');
    console.log('The server is up and running, press Ctrl+C to stop server.');
    console.log('---------------------------------------------------------------');
}

/**********************************/
/* goodBye function               */
/**********************************/
function setLeaveMsg() {
    process.stdin.resume();

    function showLeaveMessage() {
        console.log(' ');
        console.log(chalk.blue('      _____              __      __                  '));
        console.log(chalk.blue('     / ___/ __  ___  ___/ /____ / /  __ __ ___       '));
        console.log(chalk.blue('    / (_ // _ \\/ _ \\/ _  //___// _ \\/ // // -_)   '));
        console.log(chalk.blue('    \\___/ \\___/\\___/\\_,_/     /_.__/\\_, / \\__/ '));
        console.log(chalk.blue('                                   /___/             '));
        console.log(' ');
        console.log('    >>> This is a simple demonstration of how the shepherd works.');
        console.log('    >>> Please visit the link to know more about this project:   ');
        console.log('    >>>   ' + chalk.yellow('https://github.com/lwmqn/mqtt-shepherd'));
        console.log(' ');
        process.exit();
    }

    process.on('SIGINT', showLeaveMessage);
}

/**********************************/
/* Indication funciton            */
/**********************************/
function readyInd () {
    ioServer.sendInd('ready', {});
    console.log(chalk.green('[         ready ] Waiting for device joining or messages...'));
}

function permitJoiningInd (timeLeft) {
    ioServer.sendInd('permitJoining', { timeLeft: timeLeft });
    // console.log(chalk.green('[ permitJoining ] ') + timeLeft + ' sec');
}

function errorInd (msg) {
    ioServer.sendInd('error', { msg: msg });
    console.log(chalk.red('[         error ] ') + msg);
}

function devIncomingInd (dev) {
    ioServer.sendInd('devIncoming', { dev: dev });
    console.log(chalk.yellow('[   devIncoming ] ') + '@' + dev.permAddr);
}

function devStatusInd (permAddr, status) {
    ioServer.sendInd('devStatus', { permAddr: permAddr, status: status });

    if (status === 'online')
        status = chalk.green(status);
    else 
        status = chalk.red(status);

    console.log(chalk.magenta('[     devStatus ] ') + '@' + permAddr + ', ' + status);
}

function attrsChangeInd (permAddr, gad) {
    ioServer.sendInd('attrsChange', { permAddr: permAddr, gad: gad });
    console.log(chalk.blue('[   attrsChange ] ') + '@' + permAddr + ', auxId: ' + gad.auxId + ', value: ' + gad.value);
}

//function toastInd (msg) {
//    ioServer.sendInd('toast', { msg: msg });
//}

function getGadType(name, appType) {
    if (name === 'dOut' && appType === 'flame')
        return 'Flame';
    else if (name == 'onOffSwitch')
        return 'Switch';
    else if (name === 'lightCtrl')
        return 'Light';
    else if (name === 'presence')
        return 'Pir';
    else
        return _.upperFirst(name);
}

function getGadValue(qnode, name, iid) {
    var val;

    if (name === 'temperature' || name === 'humidity' || name === 'illuminance')
        val = qnode.so.get(name, iid, 'sensorValue');
    else if (name === 'buzzer' || name === 'lightCtrl')
        val = qnode.so.get(name, iid, 'onOff');
    else if (name === 'onOffSwitch' || name === 'presence')
        val = qnode.so.get(name, iid, 'dInState');
    else if (name === 'dOut')
        val = qnode.so.get(name, iid, 'dOutState');

    return val;
}

function mainResourceName(name) {
    if (name === 'temperature' || name === 'humidity' || name === 'illuminance')
        return 'sensorValue';
    else if (name === 'buzzer' || name === 'lightCtrl')
        return 'onOff';
    else if (name === 'onOffSwitch' || name === 'presence')
        return 'dInState';
    else if (name === 'dOut')
        return 'dOutState';
}

function startObservingD01(qnode) {
    isD01Observed = true;
    setTimeout(function () {
        qnode.writeAttrsReq('temperature/0/sensorValue', { pmin: 1, pmax: 60, stp: 0.1 }).then(function (rsp) {
            return qnode.observeReq('temperature/0/sensorValue');
        }).fail(function (err) {
            console.log(err);
        }).done();

        qnode.writeAttrsReq('humidity/0/sensorValue', { pmin: 1, pmax: 60, stp: 0.1 }).then(function (rsp) {
            return qnode.observeReq('humidity/0/sensorValue');
        }).fail(function (err) {
            console.log(err);
        }).done();

        qnode.writeAttrsReq('illuminance/1/sensorValue', { pmin: 1, pmax: 60, stp: 1 }).then(function (rsp) {
            return qnode.observeReq('illuminance/1/sensorValue');
        }).fail(function (err) {
            console.log(err);
        }).done();
    }, 600);
}

function startObservingD02(qnode) {
    isD02Observed = true;
    setTimeout(function () {
        qnode.writeAttrsReq('onOffSwitch/0/dInState', { pmin: 1, pmax: 60, stp: 0.1 }).then(function (rsp) {
            return qnode.observeReq('onOffSwitch/0/dInState');
        }).fail(function (err) {
            console.log(err);
        }).done();
    }, 600);
}

function startObservingD03(qnode) {
    isD03Observed = true;
    setTimeout(function () {
        qnode.writeAttrsReq('lightCtrl/0/onOff', { pmin: 1, pmax: 60, stp: 0.1 }).then(function (rsp) {
            return qnode.observeReq('lightCtrl/0/onOff');
        }).fail(function (err) {
            console.log(err);
        }).done();
    }, 600);
}

function startObservingD04(qnode) {
    isD04Observed = true;
    setTimeout(function () {
        qnode.writeAttrsReq('presence/0/dInState', { pmin: 1, pmax: 60, stp: 0.1 }).then(function (rsp) {
            return qnode.observeReq('presence/0/dInState');
        }).fail(function (err) {
            console.log(err);
        }).done();

        qnode.writeAttrsReq('dOut/0/dOutState', { pmin: 1, pmax: 60, stp: 0.1 }).then(function (rsp) {
            return qnode.observeReq('dOut/0/dOutState');
        }).fail(function (err) {
            console.log(err);
        }).done();
    }, 600);
}


module.exports = app;

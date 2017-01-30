// NOTE: This test is specific to the CC2650 sensortag.  But the patch in issues/532 hopefully is generic enough..
// NOTE2: You must pass the UUID of the device you want to connect to on the commandline.. (process.argv[2])

// It will attempt to:
// * Do a scan
// * Write to the characteristic to enable temperature reading (IR)
// * Read back from the IR Temp characteristic (show that its working)
// * Enable notifications for IR Temp
// * Start a data stream for notifications for IR Temp and print those to the console
// * To show broken data streams, it will requery for services and characteristics then read from the Luxometer characteristic
// without the patch in https://github.com/sandeepmistry/noble/issues/532 the data stream from IR Temp will stop.

let noble = require("noble");

let ourDevice = null;
let devices = [];
let scanCompleteCallback = null;

// create full sensortag UUIDs with smaller stubs
const SENSORTAG_BASE_UUID = "04514000b000000000000000";
const SENSORTAG_PREFIX = "f000";

const IR_TEMP_READ = buildUUID("aa01");
const IR_TEMP_CONFIGURE = buildUUID("aa02");
const LUXOMETER_READ = buildUUID("aa71");

function buildUUID(type) {
    return SENSORTAG_PREFIX + type + SENSORTAG_BASE_UUID;
}

// setup noble
configureBluetooth();

// start the one and only scan
setTimeout(() => startScanning(), 1000);

// do a single scan
function activeScan(res, callback) {
    scanCompleteCallback = callback;

    // keep the already connected devices across multiple scans.
    let newDevices = devices.filter((dev) => { return dev.isConnected(); });

    devices = newDevices; //udpate devices array
    noble.startScanning([], false);
}

// setup noble handlers
function configureBluetooth() {
    noble.on("stateChange", (state) => {});

    noble.on("scanStart", () => {
        console.log("->Scan Started");
        setTimeout(() => noble.stopScanning(), 3000); //scan for 3 seconds
    });

    noble.on("scanStop", function() {
        console.log("<-Scan Stopped");

        if (typeof scanCompleteCallback === "function") {
            scanCompleteCallback();
            scanCompleteCallback = null;
        }
    });

    noble.on("discover", (dev) => { 
        new Promise((resolve, reject) => {
            devices.forEach((d) => {
                if (dev.id == d.id)
                    reject();
            });
            devices.push(dev);  //discovered a new device add to array
            resolve();
        })
    });
}

// check that the user passed a uuid or mac for connecting to..then scan and connect.
function startScanning() {
    if (process.argv[2] === undefined) {
        console.log("You must specify a device handle for scanning.\nOn MAC that is a full 128bit UUID\nOn linux a undotted MAC Address\n")
        return;
    }

    console.log("looking for device -> " + process.argv[2])
    activeScan(null, () => {
        devices.forEach(d => {
            if (d.id === process.argv[2]) {
                connectToDevice(d).then(() => {
                    ourDevice = d;
                    setTimeout(beginTest, 0); // this fires up the actual tests after connection
                });
            }
        });
    });
}

function beginTest() {
    writeCharacteristic(ourDevice, IR_TEMP_CONFIGURE, "01") // enable reading temperature
    .then(() => {
        setTimeout(() => readData(), 1000); // it takes a second for things to take hold after a write..
    });
}

function readData() {
    readCharacteristic(ourDevice, IR_TEMP_READ)
    .then((data) => {
        console.log("temperature data " + data.toString('hex'));
    })
    .then(enableNotify.bind(null, ourDevice, IR_TEMP_READ))
    .then(enableStreamReading.bind(null, ourDevice, IR_TEMP_READ))
    .then(() => {
        console.log("We should be streaming..");
        setTimeout(() => attemptDisrupt(), 3000);
    });
}

function attemptDisrupt() {
    console.log("\n\n\nRead During Streaming... can break streaming\n\n");
    readCharacteristic(ourDevice, LUXOMETER_READ);
}

// write a value to the characteristic
function writeCharacteristic(dev, characteristicUUID, value) {
    return new Promise((resolve, reject) => {
        getServices(dev)  //disvoer all services
        .then(data => getSpecificCharacteristic(data, characteristicUUID))
        .then((deviceAndServicesAndCharacteristic) => {
            let dev = deviceAndServicesAndCharacteristic[0];
            let service = deviceAndServicesAndCharacteristic[1];
            let characteristic = deviceAndServicesAndCharacteristic[2];

            return new Promise((resolve, reject) => {
                let arr = [];
                for (let i=0; i<value.length; i+=2) {
                    let s = value[i] + value[i+1];
                    arr.push(parseInt(s, 10));
                }
                let buf = Buffer.alloc(arr.length);
                for (let i=0; i<arr.length; ++i) {
                    buf.writeUInt8(arr[i], i);
                }

                characteristic.write(buf, false, (error, data) => {
                    console.log(">> Service: Setting Value  " + arr.toString() + " for characteristic " + characteristic.uuid);
                    resolve(); // resolve on write callback.  if this fails we may need a resolve for other paths.
                });
            })
        })
        .then(() => resolve())
        .catch((e) => reject());
    });
}

//return a string as hex from the characteristic
function readCharacteristic(dev, characteristicUUID) {
    console.log("readCharacteristic() dev=" + dev.id + " char " + characteristicUUID);
    return new Promise((resolve, reject) => {
        getServices(dev) //get all services
        .then(data => getSpecificCharacteristic(data, characteristicUUID)) //filter for just one characteristic
        .then((deviceAndServicesAndCharacteristic) => { //returned an array -> [dev, service, characteristic]
            let dev = deviceAndServicesAndCharacteristic[0];
            let service = deviceAndServicesAndCharacteristic[1];
            let characteristic = deviceAndServicesAndCharacteristic[2];

            characteristic.read((error, data) => {
                if (error) {
                    console.log("read returned error " + error);
                    res.send(new Error(error)); // we need to bail here
                    reject();
                }

                resolve(data); // resolve and return data.
            });
        })
    .catch((e) => reject());
    });
}

function enableNotify(dev, characteristicUUID) {
    return new Promise((resolve, reject) => {
        getServices(dev)  //get all services via device.discoverServices()
        .then(data => getSpecificCharacteristic(data, characteristicUUID)) //filter for a single characteristic
        .then((deviceAndServicesAndCharacteristic) => {  //returned an array [dev, service, characteristic ]
            let dev = deviceAndServicesAndCharacteristic[0];
            let service = deviceAndServicesAndCharacteristic[1];
            let characteristic = deviceAndServicesAndCharacteristic[2];

            return new Promise((resolve, reject) => {
                characteristic.subscribe((error) => {
                    console.log("subscribed to " + characteristicUUID);
                    resolve();
                });
            });
        })
        .then(() => resolve()) //resolve the outer promise
        .catch(e => {
            console.log("Catch an error in enableNotify()");
        });
    });
}

// read data back via stream and print it to the console
function enableStreamReading(dev, characteristicUUID) {

    return new Promise((resolve, reject) => {
        getServices(dev) // get all services
        .then(data => getSpecificCharacteristic(data, characteristicUUID)) //filter for a single characteristic
        .then((deviceAndServicesAndCharacteristic) => {  //returned an array [dev, service, characteristic]
            let dev = deviceAndServicesAndCharacteristic[0];
            let service = deviceAndServicesAndCharacteristic[1];
            let characteristic = deviceAndServicesAndCharacteristic[2];

            characteristic.on("data", (data, isNotification) => {
                if (isNotification)
                    console.log("notify["+characteristicUUID+"] = " + data.toString('hex'))
            });
        })
        .then(() => resolve())
        .catch(e => reject());
    });
}

// take an array [dev, services] and filter for a characteristicUUID in those services, tack it on to the array and push it out.
//returns [dev, services, characteristic]
function getSpecificCharacteristic(deviceAndServices, findThisCharacteristic) {
    let dev = deviceAndServices[0];
    let services = deviceAndServices[1];

    return new Promise((resolve, reject) => {
        services.forEach((service) => {

            service.discoverCharacteristics([], (error, characteristics) => {
                characteristics.forEach((characteristic, j, characteristics) => {

                    if (findThisCharacteristic == characteristic.uuid) {
                        console.log("Service uuid " + service.uuid + " characteristic [" + j + "] uuid: " + characteristic.uuid);
                        resolve([dev, services, characteristic]);
                    }
                });
            });
        });
    });
}

function getServices(dev) {
    return new Promise((resolve, reject) => {
        dev.discoverServices(null, (error, services) => { // getting ALL services
            resolve([dev, services]);
        });
    });
}

function connectToDevice(dev) {
    return new Promise((resolve, reject) => {
        dev.connect((error) => resolve(dev));
    });
}
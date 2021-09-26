'use strict';

const axios = require('axios');

module.exports = (homebridge) => {
    /* this is the starting point for the plugin where we register the accessory */
    homebridge.registerAccessory('homebridge-sonoff-diy-mini', 'SonoffDIYMini', SwitchAccessory)
};

const POLLING_INTERVAL = 5000; // ms

class SwitchAccessory {
    constructor(log, config, api) {
        const {Service, Characteristic} = api.hap;
        /*
         * The constructor function is called when the plugin is registered.
         * log is a function that can be used to log output to the homebridge console
         * config is an object that contains the config for this plugin that was defined the homebridge config.json
         */

        /* assign both log and config to properties on 'this' class so we can use them in other methods */
        this.log = log;
        this.config = config;
        this.Service = Service;
        this.Characteristic = Characteristic;

        /*
         * A HomeKit accessory can have many "services". This will create our base service,
         * Service types are defined in this code: https://github.com/KhaosT/HAP-NodeJS/blob/master/lib/gen/HomeKitTypes.js
         * Search for "* Service" to tab through each available service type.
         * Take note of the available "Required" and "Optional" Characteristics for the service you are creating
         */
        this.service = new Service.Switch(this.config.name);
        this.onCharacteristic = this.service.getCharacteristic(this.Characteristic.On);

        this.queue = new Queue(log, 2, 100);
    }

    getServices() {
        /*
         * The getServices function is called by Homebridge and should return an array of Services this accessory is exposing.
         * It is also where we bootstrap the plugin to tell Homebridge which function to use for which action.
         */

        /* Create a new information service. This just tells HomeKit about our accessory. */
        const informationService = new this.Service.AccessoryInformation()
            .setCharacteristic(this.Characteristic.Manufacturer, 'Default-Manufacturer')
            .setCharacteristic(this.Characteristic.Model, 'Default-Model')
            .setCharacteristic(this.Characteristic.SerialNumber, 'Default-Serial')

        /*
         * For each of the service characteristics we need to register setters and getter functions
         * 'get' is called when HomeKit wants to retrieve the current state of the characteristic
         * 'set' is called when HomeKit wants to update the value of the characteristic
         */
        this.onCharacteristic
            .on('get', this.getOnCharacteristicHandler.bind(this))
            .on('set', this.setOnCharacteristicHandler.bind(this));

        this.trackState();

        /* Return both the main service (this.service) and the informationService */
        return [informationService, this.service];
    }

    setOnCharacteristicHandler(value, callback) {
        /* this is called when HomeKit wants to update the value of the characteristic as defined in our getServices() function */


        /* Log to the console the value whenever this function is called */
        this.log(`Handling SET request, value:`, value);

        this.queue.immediate(() => {
            return this.setOn(value)
                .then(() => {
                    this.state = value;
                    callback(null);
                })
                .catch(callback);
        });
    }

    getOnCharacteristicHandler(callback) {
        /*
         * this is called when HomeKit wants to retrieve the current state of the characteristic as defined in our getServices() function
         * it's called each time you open the Home app or when you open control center
         */

        /* Log to the console the value whenever this function is called */
        this.log(`Handling GET request`);

        /*
         * The callback function should be called to return the value
         * The first argument in the function should be null unless and error occured
         * The second argument in the function should be the current value of the characteristic
         * This is just an example so we will return the value from `this.isOn` which is where we stored the value in the set handler
         */
        callback(null, this.state);
    }

    async setOn(value) {
        return await this.request("/zeroconf/switch", {
            "data": {
                "switch": value ? "on" : "off"
            }
        });
    }

    getOn() {
        return this.request("/zeroconf/info", {data: {}})
            .then(result => {
                const {error, data} = result;
                if (error) {
                    return Promise.reject(error);
                }
                else {
                    return data.switch === "on";
                }
            });
    }

    trackState() {
        /**
         * Polling switch status to (almost) instantly update it in HomeKit e.g. for Automation triggers
         */
        this.trackIntervalId = setInterval(this.loadState, POLLING_INTERVAL);
        this.log(`Started refreshing Switch status every ${POLLING_INTERVAL} ms`);
    }

    loadState = async () => {
        this.queue.attempt(async () => {
            const newState = await this.getOn();
            if (this.state !== newState) {
                this.state = newState;
                this.onCharacteristic.updateValue(this.state);
                this.log('*** External state change detected! New state:', newState, '***');
            }
        })
    };

    request(path, data) {
        const {address, port} = this.config;
        const url = `http://${address}:${port}${path}`;

        return axios.post(url, data)
            .then(({data}) => data);
    }
}

class Queue {
    requests = [];
    immediateRequests = [];
    inProgress = false;

    constructor(log, frequency, wait) {
        this.log = log;
        this.wait = wait;
        const timeout = Math.ceil(1000 / frequency);
        setInterval(this.iteration, timeout);
        this.log('Queue created, freq:', frequency, 'timeout', timeout);
    }

    immediate(cb) {
        this.log('Queue immediate callback added');
        this.immediateRequests.push(cb);
    }

    attempt(cb) {
        if (!this.inProgress) {
            this.run(cb);
        }
    }

    async run(cb) {
        this.inProgress = true;
        try {
            await cb();
        }
        catch (e) {
            this.log.error(e);
        } finally {
            setTimeout(() => this.inProgress = false, this.wait);
        }
    }

    iteration = async () => {
        if (this.inProgress) {
            return;
        }
        if (this.immediateRequests.length > 0) {
            this.log('Queue immediate request found');
            const cb = this.immediateRequests.shift();
            await this.run(cb, true);
        }
        else if (this.requests.length > 0) {
            this.log('Queue request found');
            const cb = this.requests.shift();
            await this.run(cb);
        }
    };
}

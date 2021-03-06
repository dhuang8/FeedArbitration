const crypto = require('crypto');
const fs = require('fs');
const Web3 = require('web3');
const SynapseSubscription = require('./subscriber.subscription.js');

//market contract
const file = "./market/contracts/abi.json";
const abi = JSON.parse(fs.readFileSync(file));
//const marketAddress = "0x7A787becFCD206EF969e3399B3cbEA8b4a15C2e8";
const marketAddress = "0x732a5496383DE6A55AE2Acc8829BE7eCE0833113";

// Create a sending RPC
const rpcHost = "https://rinkeby.infura.io";
const web3 = new Web3(new Web3.providers.HttpProvider(rpcHost));
const SynapseMarket = new web3.eth.Contract(abi, marketAddress);

// Create a listening RPC
const rpcHost_listen = "ws://34.193.100.223:8546";
const web3_listen = new Web3(Web3.givenProvider || rpcHost_listen);
const SynapseMarket_listen = new web3_listen.eth.Contract(abi, marketAddress);
SynapseMarket_listen.events.allEvents({}, (err, res) => { console.log("76575event", err, res) })

//accounts
const accounts = require('./account.js');
const privateKeyHex = "0x7909ef9ab5279d31a74b9f49c58cf5be5c033ae7e9d7e2eb46a071b9802c5e22";
const account = new accounts(privateKeyHex);

account.setWeb3(web3);

console.log(web3.eth.accounts.wallet[0].address)

function sha256(item) {
    const hash = crypto.createHash("sha256");
    hash.update(item);
    return hash.digest();
}


class SynapseSubscriber {
    constructor(marketAddress, configFile = ".synapsesubscriber", callback = undefined) {
        this.marketInstance = SynapseMarket;
        this.checkForRegister(configFile, callback);
    }

    // Check whether or not we need to register, if so register
    checkForRegister(configFile, callback) {
        // Already regsitered
        if (fs.existsSync(configFile)) {
            const data = JSON.parse(fs.readFileSync(configFile));

            this.private_key = data.private_key;

            // Generate a secp224k1 keypair
            this.keypair = crypto.createECDH('secp224k1');
            this.keypair.setPrivateKey(data.private_key, 'hex');

            console.log ("public key", this.keypair.getPublicKey('hex', 'compressed'));
            console.log ("private key", this.keypair.getPrivateKey('hex'));

            // Load the subscriptions into internal objects
            this.subscriptions = data.subscriptions.map(data => {
                const obj = SynapseSubscription.fromObject(data);

                // If a callback was passed, initiate the stream with that
                if (callback) {
                    obj.data(callback);
                }

                return obj;
            });

            return;
        }

        this.keypair = crypto.createECDH('secp224k1');
        this.keypair.generateKeys('hex', 'compressed');

        console.log("Successfully registered");
	    console.log ("public key", this.keypair.getPublicKey('hex', 'compressed'));
            console.log ("private key", this.keypair.getPrivateKey('hex'));

        fs.writeFileSync(".synapsesubscriber", JSON.stringify({
            private_key: this.keypair.getPrivateKey('hex'),
            subscriptions: []
        }));

        this.subscriptions = [];
    }

    // Create a new subscription
    newSubscription(group, callback) {
        // Conver group to bytes32 string
        group = web3.utils.utf8ToHex(group);

        console.log("Looking for a provider of data");

        // Send the request
        this.marketInstance.methods.requestSynapseProvider(group).send({
            from: web3.eth.accounts.wallet[0].address,
            gas: 4700000 // TODO - not this
        }, (err, result) => {
            if (err) {
                throw err;
            }

            console.log("Sent the request");

            // Watch for SynapseProviderFound events
            const event = SynapseMarket_listen.SynapseProviderFound();

            event.watch((err, found_res) => {
                if (err) {
                    throw err;
                }

                // Make sure it was generated by the above request
                if (found_res.transactionHash != result.transactionHash) {
                    return;
                }

                console.log("Found a provider of data");

                // Get the index of the provider
                const provider_index = found_res.args.index;

                this.newSubscriptionWithIndex(provider_index, group, 0, callback);
            });
        });
    }

    // Start a subscription with a provider index
    newSubscriptionWithIndex(provider_index, group, amount, callback) {
        console.log("Starting subscription with index", provider_index);

        // Make sure group is a bytes32 compatible object
        if (group.substring(0, 2) != '0x') {
            group = web3.utils.utf8ToHex(group);
        }

        // Get the information of the provider
        
        this.marketInstance.methods.getProviderAddress(group, provider_index).call().then(providers_address => {
            this.marketInstance.methods.getProviderPublic(group, provider_index).call().then(providers_public => {
                console.log(providers_address, providers_public)
                // Parse solidity's garbage.
                let provider_public_hex = providers_public.substr(2);//web3.utils.fromDecimal(providers_public).substr(2);

                if (provider_public_hex.length != (28 * 2)) {
                    provider_public_hex = provider_public_hex.slice(0,58);
                }


                // Do the key exchange
                console.log("provider_public_hex",provider_public_hex);
                const provider_public_buf = Buffer.from(provider_public_hex, 'hex');
                console.log("provider_public_buf",provider_public_buf);
                const secret_raw = this.keypair.computeSecret(provider_public_hex,'hex','hex');

		console.log('secret_raw');
		console.log(secret_raw);
		const secret = sha256(secret_raw);

                // Generate a nonce
                const nonce = crypto.randomBytes(16);
                console.log("nonce",nonce);
                console.log("secret",secret);
                const nonce_hex = "0x" + new Buffer(nonce).toString('hex');

                // Generate a UUID
                const uuid = crypto.randomBytes(32);

                // Setup the cipher object with the secret and nonce
                const cipher = crypto.createCipheriv('aes-256-ctr', secret, nonce);

                cipher.setAutoPadding(false);

                // Encrypt it (output is buffer)
                const euuid = cipher.update(uuid) +
                    cipher.final();

                // Sanity check
                if (euuid.length > 32) {
                    throw new Error("encrypted uuid is too long!");
                }

                // Hexify the euuid
                const euuid_hex = "0x" + new Buffer(euuid, 'ascii').toString('hex');

                // Get my public key
                const public_key = "0x" + this.keypair.getPublicKey('hex', 'compressed');

                // Parse the amount
                amount = web3.utils.fromDecimal(amount);

                console.log(group,
                    providers_address,
                    public_key,
                    euuid_hex,
                    nonce_hex,
                    amount)
                // Initiate the data feed
                this.marketInstance.methods.initSynapseDataFeed(
                    group,
                    providers_address,
                    public_key,
                    euuid_hex,
                    nonce_hex,
                    amount
                ).send({
                    from: web3.eth.accounts.wallet[0].address,
                    //value:10000,
                    gas: 4700000 // TODO - not this

                }).once('transactionHash', (transactionHash) => {
                    //SynapseMarket_listen.events.allEvents({}, function (error, log) {
                    //    if (!error)
                    //        console.log(875685,log);
                    //});

                    //console.log(3,transactionHash) 

                }).on("error", (error) => {
                    console.log(37776, error);
                }).then((receipt) => {
                    console.log("Data feed initiated");

                    // Create the subscription object
                    console.log("room", uuid.toString('base64'));
                    const subscription = new SynapseSubscription(public_key, secret, nonce_hex, uuid.toString('base64'));
                    subscription.data(callback);
                })

            });
        });
        
    }
}

const subscriber = new SynapseSubscriber(marketAddress, ".synapsesubscriber");

setTimeout(() => {
    subscriber.newSubscriptionWithIndex(0, "tom_08", 10, (err, data) => {
        console.log(765765, err);
        console.log(973, data);
    });
}, 5000);

module.exports = SynapseSubscriber;

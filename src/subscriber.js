const crypto = require('crypto');
const fs = require('fs');
const Web3 = require('web3');
const SynapseSubscription = require('./subscription.js');

//market contract
const file = "./market/contracts/abi.json";
const abi = JSON.parse(fs.readFileSync(file));
const marketAddress = "0x98f6d007a840782eea0fbc6584ab95e8c86d677e";

// Create a sending RPC
const rpcHost = "http://localhost:8545";
const web3 = new Web3(Web3.givenProvider || rpcHost);
const SynapseMarket = new web3.eth.Contract(abi, marketAddress);

// Create a listening RPC
const rpcHost_listen = "ws://localhost:8546";
const web3_listen = new Web3(Web3.givenProvider || rpcHost_listen);
const SynapseMarket_listen = new web3_listen.eth.Contract(abi, marketAddress);

//accounts
const accounts = require('./account.js');
const privateKeyHex = "0x8d2246c6f1238a97e84f39e18f84593a44e6622b67b8cebb7788320486141f95";
const account = new accounts(privateKeyHex);

account.setWeb3(web3);
function sha256(item) {
    const hash = crypto.createHash("sha256");
    hash.update(item);
    return hash.digest();
}


class SynapseSubscriber {
    constructor(marketAddress, configFile=".synapsesubscriber", callback = undefined) {
        this.marketInstance = SynapseMarket;
        this.checkForRegister(configFile, callback);
    }

    // Check whether or not we need to register, if so register
    checkForRegister(configFile, callback) {
        // Already regsitered
        if ( fs.existsSync(configFile) ) {
            const data = JSON.parse(fs.readFileSync(configFile));

            this.private_key = data.private_key;

            // Generate a secp224k1 keypair
            this.keypair = crypto.createECDH('secp224k1');
            this.keypair.setPrivateKey(data.private_key, 'hex');

            // Load the subscriptions into internal objects
            this.subscriptions = data.subscriptions.map(data => {
                const obj = SynapseSubscription.fromObject(data);

                // If a callback was passed, initiate the stream with that
                if ( callback ) {
                    obj.data(callback);
                }

                return obj;
            });

            return;
        }

        this.keypair = crypto.createECDH('secp224k1');
        this.keypair.generateKeys('hex', 'compressed');

        console.log("Successfully registered");

        fs.writeFileSync(".synapsesubscriber", JSON.stringify({
            private_key: this.keypair.getPrivateKey('hex'),
            subscriptions: []
        }));

        this.subscriptions = [];
    }

    // Create a new subscription
    newSubsription(group, callback) {
        // Conver group to bytes32 string
        group = '0x' + (new Buffer(group)).toString('hex');

        console.log("Looking for a provider of data");

        // Send the request
        this.marketInstance.methods.requestSynapseProvider(group).send({
            from: web3.eth.accounts.wallet[0].address,
            gas: 300000 // TODO - not this
        }, (err, result) => {
            if ( err ) {
                throw err;
            }

            console.log("Sent the request");

            // Watch for SynapseProviderFound events
            const event = SynapseMarket_listen.SynapseProviderFound();

            event.watch((err, found_res) => {
                if ( err ) {
                    throw err;
                }

                // Make sure it was generated by the above request
                if ( found_res.transactionHash != result.transactionHash ) {
                    return;
                }

                console.log("Found a provider of data");

                // Get the index of the provider
                const provider_index = found_res.args.index;

                this.newSubscriptionWithIndex(provider_index, group, callback);
            });
        });
    }

    // Start a subscription with a provider index
    newSubscriptionWithIndex(provider_index, group, callback) {
        console.log("Starting subscription with index", provider_index);
        // Get the information of the provider


        console.log(this.marketInstance.methods.getProviderAddress);
        //console.log(provider_address);
        this.marketInstance.methods.getProviderAddress(web3.utils.utf8ToHex(group), provider_index).call().then( (res)=>{
            
            const providers_address = res;
            this.marketInstance.methods.getProviderPublic(web3.utils.utf8ToHex(group), provider_index).call().then( (res)=>{

                const providers_public = res;

                console.log(providers_address);
                console.log(web3.utils.fromDecimal(providers_public).substr(2));

                // Do the key exchange
                const secrethex = sha256(this.keypair.computeSecret(new Buffer("0"+web3.utils.fromDecimal(providers_public).substr(2), 'hex')));
                console.log(secrethex.length);
                // Generate a nonce
                const nonce = crypto.randomBytes(16);
                const noncehex = "0x" + new Buffer(nonce).toString('hex');
                console.log(nonce.length);
                // Generate a UUID
                const uuid = crypto.randomBytes(32);

                // Encrypt it with the secret key
                const cipher = crypto.createCipheriv('aes-256-ctr', (secrethex), nonce);
                let euuid = cipher.update(uuid);
                euuid=euuid+cipher.final();
                let euuid_hex =  web3.utils.utf8ToHex(euuid.toString());
                // Get my public key
                const public_key = "0x" + this.keypair.getPublicKey('hex');

                // Initiate the data feed
                //console.log(web3.utils.utf8ToHex(group), providers_address, public_key, euuid_hex, noncehex, "0x0");

                this.marketInstance.methods.initSynapseDataFeed(web3.utils.utf8ToHex(group), providers_address, public_key, euuid_hex, noncehex, "0x0").send({
                    from: web3.eth.accounts.wallet[0].address,
                    gas: 300000 // TODO - not this
                } , (err, result) => {
                    if ( err ) {
                        throw err;
                    }

                    console.log("Data feed initiated");

                    // Create the subscription object
                    const subscription = new SynapseSubscription(public_key, secrethex, noncehex, uuid.toString('base64'));
                    subscription.data(callback);
                });
              });
            });
        }
}

const subscriber = new SynapseSubscriber(marketAddress, ".synapsesubscriber");

setTimeout(() => {
    subscriber.newSubscriptionWithIndex(0, "cool2", (err, data) => {
        console.log(err);
        console.log(data);
    })
}, 5000);

module.exports = SynapseSubscriber;

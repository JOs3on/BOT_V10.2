const Sniper = require('./Sniper');
require('dotenv').config();

class SniperManager {
    constructor() {
        this.snipers = [];
    }

    async addSniper(lp) {
        try {
            const buyAmount = Number(process.env.BUY_AMOUNT);
            const sellTargetPrice = Number(process.env.SELL_TARGET_PRICE);

            if (isNaN(buyAmount) || isNaN(sellTargetPrice)) {
                throw new Error(
                    `Invalid BUY_AMOUNT or SELL_TARGET_PRICE in .env`
                );
            }

            const sniperCfg = { ...lp, buyAmount, sellTargetPrice };

            // One‑hop: cfg + full LP data
            const sniper = new Sniper(sniperCfg, lp);
            this.snipers.push(sniper);

            console.log(
                '[SniperManager] Sniper added for:', lp.baseMint,
                '| Target:', sellTargetPrice + '%'
            );

            // MODIFIED: Implement the new buy -> analyze -> monitor flow
            console.log('[SniperManager] Step 1: Executing buy...');
            const buyTxId = await sniper.executeBuy();

            if (buyTxId) {
                console.log(`[SniperManager] Step 2: Buy transaction sent (${buyTxId}). Calculating actual price...`);
                await sniper.calculateAndUpdateSellPrice(buyTxId);

                console.log('[SniperManager] Step 3: Subscribing to vault for price monitoring...');
                await sniper.subscribeToVault();
            } else {
                console.error('[SniperManager] Buy transaction failed to return a signature. Halting sniper.');
            }
        } catch (err) {
            console.error('[SniperManager] addSniper error:', err.message);
        }
    }

    /*  helper mutators  */
    setBuyAmount(index, amount) {
        if (this.snipers[index]) {
            this.snipers[index].setBuyAmount?.(amount);
            console.log(`Buy amount set to ${amount} for sniper at index ${index}`);
        } else {
            console.error('Sniper not found at index:', index);
        }
    }

    setSellTargetPrice(index, price) {
        if (this.snipers[index]) {
            this.snipers[index].setSellTargetPrice?.(price);
            console.log(`Sell target price set to ${price}% for sniper at index ${index}`);
        } else {
            console.error('Sniper not found at index:', index);
        }
    }

    async init() {
        console.log('Sniper Manager initialized');
    }
}

module.exports = new SniperManager();

// --- START OF FILE Sniper.js (Updated) ---

const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const swapCreator = require('./swapCreator');
const bs58 = require('bs58');
const { MongoClient } = require('mongodb');
// ADDED: Import the missing function from the spl-token library
const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
require('dotenv').config();

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

class Sniper {
    constructor(cfg, fullLpData) {
        // ... constructor is unchanged ...
        Object.assign(this, cfg);
        this.buyAmount = cfg.buyAmount;
        this.targetMultiplier = 1 + cfg.sellTargetPrice / 100;

        this.actualBuyPrice = 0;
        this.calculatedSell = 0;

        this.decimalFactor = 10 ** (this.quoteDecimals - this.baseDecimals);

        this.owner = Keypair.fromSecretKey(bs58.default.decode(process.env.WALLET_PRIVATE_KEY));
        this.connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');

        this.tokenData = fullLpData;
        this.vaultSubId = null;
        this.db = null;

        console.log('[Sniper] Created for token:', this.baseMint);
    }

    /* ------------ BUY ONCE ---------------- */
    async executeBuy() {
        // ... executeBuy is unchanged ...
        if (!this.tokenData) throw new Error('Token data missing for buy phase');

        console.log(`[BUY] Swapping ${this.buyAmount} quote tokens for base`);

        const txSignature = await swapCreator.swapTokens({
            tokenData: this.tokenData,
            amountSpecified: this.toLamports(this.buyAmount, this.quoteDecimals),
            swapBaseIn: false,
            owner: this.owner,
        });

        return txSignature;
    }

    /* ------------ PRICE CALCULATION ---------------- */
    async calculateAndUpdateSellPrice(txid) {
        console.log(`[ANALYSIS] Fetching transaction details for ${txid} to calculate actual buy price...`);
        try {
            const tx = await this.connection.getParsedTransaction(txid, {
                maxSupportedTransactionVersion: 0,
            });

            if (!tx || !tx.meta) {
                throw new Error("Parsed transaction not found.");
            }

            const { preTokenBalances, postTokenBalances } = tx.meta;
            const ownerAddress = this.owner.publicKey.toString();

            // Find how much of the new token we received (this part is correct)
            const postTokenBalance = postTokenBalances.find(b => b.owner === ownerAddress && b.mint === this.baseMint);
            const preTokenBalance = preTokenBalances.find(b => b.owner === ownerAddress && b.mint === this.baseMint);
            const tokenAmountReceived = (postTokenBalance?.uiTokenAmount.uiAmount || 0) - (preTokenBalance?.uiTokenAmount.uiAmount || 0);

            // MODIFIED: This is the fix. We use the predefined buyAmount instead of calculating from wallet balance changes.
            const solSpent = this.buyAmount;

            if (tokenAmountReceived === 0) {
                throw new Error("Could not determine token amount received from transaction.");
            }

            this.actualBuyPrice = solSpent / tokenAmountReceived;

            // This calculation is now correct because actualBuyPrice is correct.
            this.calculatedSell = this.actualBuyPrice * this.targetMultiplier;

            console.log(`[ANALYSIS] Actual Buy Price: ${this.actualBuyPrice.toExponential(6)} SOL/token`);
            console.log(`[ANALYSIS] New Sell Target: ${this.calculatedSell.toExponential(6)} SOL/token (at ${this.targetMultiplier}x)`);

        } catch (error) {
            console.error('[ANALYSIS] Error calculating actual buy price:', error.message);
            console.warn('[ANALYSIS] Using initial price (V) as a fallback due to error.');
            this.actualBuyPrice = parseFloat(this.V);
            this.calculatedSell = this.actualBuyPrice * this.targetMultiplier;
        }
    }

    /* ------------ LIVE PRICE WATCHER ---------------- */
    async subscribeToVault() {
        if (this.calculatedSell === 0) {
            console.error('[SUB] Cannot subscribe to vault: Sell price has not been calculated. Run calculateAndUpdateSellPrice first.');
            return;
        }

        const quoteVault = new PublicKey(this.quoteVault);
        this.vaultSubId = this.connection.onAccountChange(
            quoteVault,
            async ({ lamports }) => {
                const quoteHuman = lamports / (10 ** this.quoteDecimals);
                const kNum = Number(this.K);

                // MODIFIED: This is the corrected price formula.
                // price = quote_reserve^2 / K. We also add a check to prevent division by zero.
                const priceNow = kNum > 0 ? (quoteHuman ** 2) / kNum : 0;

                console.log(`[PRICE] ${this.baseMint.slice(0, 4)}: ${priceNow.toExponential(6)} SOL | Target: ${this.calculatedSell.toExponential(6)}`);

                if (priceNow > 0 && priceNow >= this.calculatedSell) {
                    await this.executeSell();
                    await this.unsubscribe();
                }
            },
            'confirmed'
        );
        console.log(`[SUB] Watching vault ${this.quoteVault} for price changes.`);
    }

    /* ------------ UNSUBSCRIBE ---------------- */
    async unsubscribe() {
        // ... unsubscribe is unchanged ...
        if (this.vaultSubId) {
            await this.connection.removeAccountChangeListener(this.vaultSubId);
            this.vaultSubId = null;
            console.log('[SUB] Unsubscribed from vault watcher.');
        }
    }

    /* ------------ SELL ---------------- */
    async executeSell() {
        // ... executeSell is unchanged ...
        const lpData = this.tokenData;

        if (!lpData) {
            throw new Error('CRITICAL: LP data was missing during sell execution.');
        }

        console.log('[SELL] Price target hit – exiting position');

        // This function will now work correctly due to the added import
        const balance = await this.getTokenBalance();
        if (balance === '0') {
            console.log('[SELL] No token balance to sell. Exiting.');
            return;
        }

        await swapCreator.swapTokens({
            tokenData: lpData,
            amountSpecified: balance, // Sell the entire balance
            swapBaseIn: true,
            owner: this.owner,
        });

        console.log('[SELL] Position exited successfully.');
    }

    /* ------------ HELPERS ---------------- */
    async getTokenBalance() {
        // This function will now work correctly.
        const tokenMint = new PublicKey(this.baseMint);
        try {
            const ata = getAssociatedTokenAddressSync(tokenMint, this.owner.publicKey);
            const balanceInfo = await this.connection.getTokenAccountBalance(ata);
            return balanceInfo.value.amount; // This is a string of the lamport amount, which is correct
        } catch (e) {
            console.warn(`[Balance] Could not fetch token balance for ${this.baseMint}:`, e.message);
            // This might happen if the ATA does not exist yet for some reason
            return '0';
        }
    }

    toLamports(x, dec) { return Math.floor(x * 10 ** dec); }
}

module.exports = Sniper;
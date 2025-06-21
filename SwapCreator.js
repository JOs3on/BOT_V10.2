const {
    Connection,
    PublicKey,
    Transaction,
    sendAndConfirmTransaction,
    ComputeBudgetProgram,
    SystemProgram
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    createCloseAccountInstruction,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    NATIVE_MINT
} = require('@solana/spl-token');
const raydium = require('@raydium-io/raydium-sdk-v2');
const BN = require('bn.js');
require('dotenv').config();

// Constants
const WSOL_MINT = NATIVE_MINT.toString();
const PRIORITY_FEE_MULTIPLIER = Number(process.env.PRIORITY_FEE_MULTIPLIER) || 1.5;
const BASE_SLIPPAGE_BPS = 50; // 0.5% default slippage
const VOLATILE_SLIPPAGE_BPS = 200; // 2% for new pools

class SwapCreator {
    constructor() {
        this.connection = new Connection(
            process.env.SOLANA_RPC_URL || process.env.SOLANA_WS_URL,
            'confirmed'
        );
        this.raydium = null;
    }

    async initializeRaydium(owner) {
        if (!this.raydium) {
            this.raydium = await raydium.Raydium.load({
                connection: this.connection,
                owner: owner,
            });
            console.log('[SwapCreator] Raydium SDK initialized');
        }
    }

    /**
     * Main swap function - creates and executes swap transaction using Raydium SDK V2
     * @param {Object} params
     * @param {Object} params.tokenData - Full token data from sniper
     * @param {string|BN} params.amountSpecified - Amount to swap (in lamports)
     * @param {boolean} params.swapBaseIn - true for base->quote, false for quote->base
     * @param {Keypair} params.owner - Wallet keypair
     */
    async swapTokens({ tokenData, amountSpecified, swapBaseIn, owner }) {
        console.log('[SwapCreator] Starting V2 SDK swap');
        if (!tokenData?.ammId) {
            throw new Error('Invalid tokenData - missing ammId');
        }

        try {
            // Initialize Raydium SDK
            await this.initializeRaydium(owner.publicKey);

            // Convert amount to BN and validate
            let amount;
            if (typeof amountSpecified === 'string') {
                amount = new BN(amountSpecified);
            } else if (typeof amountSpecified === 'number') {
                amount = new BN(amountSpecified.toString());
            } else if (BN.isBN(amountSpecified)) {
                amount = amountSpecified;
            } else {
                throw new Error(`Invalid amount type: ${typeof amountSpecified}`);
            }

            if (!amount || amount.isZero()) {
                throw new Error('Invalid amount specified');
            }

            console.log(`[SwapCreator] Swapping ${amount.toString()} lamports, swapBaseIn: ${swapBaseIn}`);

            // Get pool info from RPC (V2 SDK method)
            const { poolInfo, poolKeys } = await this.raydium.liquidity.getPoolInfoFromRpc({
                poolId: tokenData.ammId
            });

            // Determine input/output mints - FIXED: ensure proper mint strings
            const inputMint = swapBaseIn ? poolInfo.mintA.address : poolInfo.mintB.address;
            const outputMint = swapBaseIn ? poolInfo.mintB.address : poolInfo.mintA.address;

            console.log(`[SwapCreator] Input mint: ${inputMint}, Output mint: ${outputMint}`);

            // Create swap transaction using V2 SDK - FIXED parameters
            const txData = await this.raydium.liquidity.swap({
                poolInfo,
                poolKeys,
                amountIn: amount, // Amount spending set first in .env
                amountOut: new BN(0), // Sdk calculates the output
                inputMint,
                fixedSide: 'in',
                txVersion: 'LEGACY',
                config: {
                    inputUseSolBalance: inputMint === WSOL_MINT,
                    outputUseSolBalance: outputMint === WSOL_MINT,
                    associatedOnly: true
                },
                computeBudgetConfig: {
                    units: 300000,
                    microLamports: Math.floor(50000 * PRIORITY_FEE_MULTIPLIER)
                },
                feePayer: owner.publicKey
            });

            // FIXED: V2 SDK returns txData with .transaction property
            const transaction = txData.transaction;
            if (!transaction) {
                throw new Error('Failed to create transaction from V2 SDK');
            }

            // Set recent blockhash before signing
            const { blockhash } = await this.connection.getLatestBlockhash();
            transaction.recentBlockhash = blockhash;
            transaction.feePayer = owner.publicKey;

            // Sign the transaction
            transaction.sign(owner);

            // Send transaction
            const signature = await this.connection.sendRawTransaction(
                transaction.serialize(),
                {
                    skipPreflight: false,
                    maxRetries: 3
                }
            );

            // Wait for confirmation
            const confirmation = await this.connection.confirmTransaction(signature, 'confirmed');
            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err}`);
            }

            console.log(`[SwapCreator] V2 SDK swap successful! Signature: ${signature}`);
            return signature;

        } catch (error) {
            console.error('[SwapCreator] V2 SDK swap failed:', error);
            throw error;
        }
    }

    createPoolKeysFromTokenData(tokenData) {
        // ADDED REQUIRED FIELD VERIFICATION
        if (!tokenData || typeof tokenData !== 'object') {
            console.error('[SwapCreator] Invalid tokenData:', tokenData);
            throw new Error('tokenData must be an object(sc)');
        }

        // ADDED REQUIRED FIELD CHECKS
        const requiredFields = ['ammId', 'baseMint', 'quoteMint', 'userBaseTokenAccount'];
        for (const field of requiredFields) {
            if (!tokenData[field]) {
                console.error(`[SwapCreator] Missing required field: ${field}`);
                console.error('Full tokenData:', JSON.stringify(tokenData, null, 2));
                throw new Error(`Missing required field: ${field}`);
            }
        }

        // Main pool accounts with graceful fallbacks
        const poolKeys = {
            id: new PublicKey(tokenData.ammId || PublicKey.default),
            baseMint: new PublicKey(tokenData.baseMint || PublicKey.default),
            quoteMint: new PublicKey(tokenData.quoteMint || PublicKey.default),
            baseVault: new PublicKey(tokenData.baseVault || PublicKey.default),
            quoteVault: new PublicKey(tokenData.quoteVault || PublicKey.default),
            authority: new PublicKey(tokenData.ammAuthority || PublicKey.default),
            openOrders: new PublicKey(tokenData.ammOpenOrders || PublicKey.default),
            targetOrders: new PublicKey(tokenData.targetOrders || PublicKey.default),
            marketId: new PublicKey(tokenData.marketId || PublicKey.default),
            programId: new PublicKey(tokenData.programId || PublicKey.default),
            marketProgramId: new PublicKey(tokenData.marketProgramId || PublicKey.default),
            marketBids: new PublicKey(tokenData.marketBids || PublicKey.default),
            marketAsks: new PublicKey(tokenData.marketAsks || PublicKey.default),
            marketEventQueue: new PublicKey(tokenData.marketEventQueue || PublicKey.default),
            marketBaseVault: new PublicKey(tokenData.marketBaseVault || PublicKey.default),
            marketQuoteVault: new PublicKey(tokenData.marketQuoteVault || PublicKey.default),
            marketAuthority: new PublicKey(tokenData.marketAuthority || PublicKey.default),
            vaultOwner: new PublicKey(tokenData.vaultOwner || PublicKey.default),
        };

        // Debug: Verify derived addresses match static data
        try {
            // V2 SDK COMPLIANT AUTHORITY DERIVATION
            const derivedAuthority = raydium.liquidity.getAssociatedAuthority({
                programId: poolKeys.programId
            }).publicKey;

            if (!derivedAuthority.equals(poolKeys.authority)) {
                console.warn('[DEBUG] Authority mismatch!',
                    `Static: ${poolKeys.authority}`,
                    `Derived: ${derivedAuthority}`
                );
            }
        } catch (derivationError) {
            console.warn('[DEBUG] Authority derivation failed:', derivationError);
        }

        return poolKeys;
    }

    createWrapSOLInstructions(owner, wsolAccount, amount) {
        const instructions = [
            SystemProgram.transfer({
                fromPubkey: owner,
                toPubkey: new PublicKey(wsolAccount),
                lamports: amount.toNumber()
            }),
            createSyncNativeInstruction(new PublicKey(wsolAccount))
        ];
        console.log('[SwapCreator] Added WSOL wrap instructions');
        return instructions;
    }

    async createTokenAccountInstructions(owner, tokenData, swapBaseIn) {
        const instructions = [];
        const outputToken = swapBaseIn ? tokenData.quoteMint : tokenData.baseMint;
        const outputTokenAccount = swapBaseIn
            ? tokenData.userQuoteTokenAccount
            : tokenData.userBaseTokenAccount;

        try {
            // Only create output token account if needed
            const accountInfo = await this.connection.getAccountInfo(
                new PublicKey(outputTokenAccount)
            );

            if (!accountInfo) {
                const outputMint = new PublicKey(outputToken);
                instructions.push(
                    createAssociatedTokenAccountInstruction(
                        owner,
                        new PublicKey(outputTokenAccount),
                        owner,
                        outputMint
                    )
                );
                console.log(`[SwapCreator] Creating output token account: ${outputTokenAccount}`);
            }
        } catch (error) {
            console.error('[SwapCreator] Token account check failed - using static address anyway', error);
        }

        return instructions;
    }

    async debugTokenAccountState(tokenData, owner) {
        try {
            console.warn('[DEBUG] Verifying token accounts:');

            // Verify base token account
            const baseAccount = await this.connection.getAccountInfo(
                new PublicKey(tokenData.userBaseTokenAccount)
            );
            console.log(`- Base ATA ${tokenData.userBaseTokenAccount}:`,
                baseAccount ? 'Exists' : 'MISSING');

            // Verify quote token account
            const quoteAccount = await this.connection.getAccountInfo(
                new PublicKey(tokenData.userQuoteTokenAccount)
            );
            console.log(`- Quote ATA ${tokenData.userQuoteTokenAccount}:`,
                quoteAccount ? 'Exists' : 'MISSING');

            // Verify pool accounts
            const baseVault = await this.connection.getAccountInfo(
                new PublicKey(tokenData.baseVault)
            );
            console.log(`- Base Vault ${tokenData.baseVault}:`,
                baseVault ? 'Exists' : 'MISSING');

        } catch (error) {
            console.error('[DEBUG] Account verification failed:', error);
        }
    }
}

// Export singleton instance
module.exports = new SwapCreator();

// Also export the class for testing
module.exports.SwapCreator = SwapCreator;

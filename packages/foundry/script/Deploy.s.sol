//SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { GavelDesk } from "../contracts/GavelDesk.sol";

/// @notice Deploys the GavelDesk against SaucerSwap V2 and Chainlink on Hedera testnet.
/// @dev Addresses are Hedera testnet; swap them for mainnet. Env overrides, all optional:
/// FUEL_PER_ORDER (tinybar, default 400000000 = 4 HBAR) is the native HBAR every order sends so its fallback can pay
/// for itself; the Schedule Service reserves SCHEDULED_GAS (default 3000000) times the gas price when it runs.
/// MAX_DEVIATION_BPS (default 300) is how far a WHBAR/USDC quote may fall below the Chainlink-implied amount.
/// MAX_ORACLE_AGE (seconds, default 90000, the 24 hour heartbeat plus an hour) bounds the feed's staleness.
contract DeployScript is ScaffoldETHDeploy {
    function run() external ScaffoldEthDeployerRunner {
        GavelDesk desk = new GavelDesk(
            GavelDesk.Config({
                router: 0x0000000000000000000000000000000000159398, // SwapRouter 0.0.1414040
                factory: 0x00000000000000000000000000000000001243eE, // SaucerSwapV2Factory 0.0.1197038
                whbarHelper: 0x000000000000000000000000000000000050a8a7, // WhbarHelper 0.0.5286055
                whbar: 0x0000000000000000000000000000000000003aD2, // WHBAR 0.0.15058
                hbarUsdFeed: 0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a, // Chainlink HBAR/USD
                usdToken: 0x0000000000000000000000000000000000001549, // USDC 0.0.5449
                usdDecimals: 6,
                maxOracleAge: vm.envOr("MAX_ORACLE_AGE", uint256(1 days + 1 hours)),
                maxDeviationBps: vm.envOr("MAX_DEVIATION_BPS", uint256(300)),
                fuelPerOrder: vm.envOr("FUEL_PER_ORDER", uint256(4e8)),
                scheduledGas: vm.envOr("SCHEDULED_GAS", uint256(3_000_000))
            })
        );
        deployments.push(Deployment({ name: "GavelDesk", addr: address(desk) }));
    }
}

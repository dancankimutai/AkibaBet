// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {AkibaVault} from "../contracts/AkibaVault.sol";

contract DeployAkibaVault is Script {
    address internal constant CELO_MAINNET_USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address internal constant CELO_SEPOLIA_USDC = 0x01C5C0122039549AD1493B8220cABEdD739BC44E;

    function run() external returns (AkibaVault vault) {
        string memory network = vm.envOr("CELO_NETWORK", string("mainnet"));
        address defaultStableToken = keccak256(bytes(network)) == keccak256(bytes("sepolia"))
            ? CELO_SEPOLIA_USDC
            : CELO_MAINNET_USDT;
        address stableToken = vm.envOr("STABLE_TOKEN_ADDRESS", defaultStableToken);
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);
        vault = new AkibaVault(stableToken);
        vm.stopBroadcast();
    }
}

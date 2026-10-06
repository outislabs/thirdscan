-- seeds projects with the main protocols live on robinhood chain (4663).
-- researched 2026-10-01. every contract address below was copied from the
-- protocol's own docs (or, for the canonical bridge, docs.robinhood.com)
-- and re-checked verbatim against that page; the source is named in each
-- row's notes. is_verified = true only where that holds. rows with no
-- officially published robinhood addresses (arcus, relay) or no contracts
-- at all (blockscout) are false with an empty contract_addresses.
-- addresses are lowercased, matching how tokens are stored. x_url is null
-- where no official link to the account was found, and logo_url is left
-- null throughout rather than guessed.
--
-- on conflict do nothing: rerunning (or a row added by hand first) never
-- overwrites curated edits.

insert into projects
  (chain, slug, name, category, description, website_url, x_url, logo_url, contract_addresses, is_verified, notes)
values
  ('robinhood', 'uniswap', 'Uniswap', 'dex',
    'AMM with v2, v3 and v4 pools and UniswapX; the main public liquidity layer on Robinhood Chain.',
    'https://uniswap.org', 'https://x.com/Uniswap', null,
    array[
      '0x8366a39cc670b4001a1121b8f6a443a643e40951',
      '0x58daec3116aae6d93017baaea7749052e8a04fa7',
      '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
      '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
      '0x8876789976decbfcbbbe364623c63652db8c0904',
      '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
      '0x73991a25c818bf1f1128deaab1492d45638de0d3',
      '0xcaf681a66d020601342297493863e78c959e5cb2',
      '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
      '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
      '0x89e5db8b5aa49aa85ac63f691524311aeb649eba'
    ],
    true,
    'addresses from developers.uniswap.org v2/v3/v4 deployment pages (Robinhood Chain 4663). Permit2 (0x000000000022d473030f116ddee9f6b43ac78ba3) is shared and omitted. contracts, in order: v4 PoolManager, v4 PositionManager, v4 Quoter, v4 StateView, UniversalRouter, v3 UniswapV3Factory, v3 NonfungiblePositionManager, v3 SwapRouter02, v3 QuoterV2, v2 Factory, v2 Router02.'),
  ('robinhood', 'pancakeswap', 'PancakeSwap', 'dex',
    'AMM with v3 and Infinity (concentrated-liquidity) pools.',
    'https://pancakeswap.finance', null, null,
    array[
      '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
      '0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9',
      '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
      '0x8553aa1615549a86882151784b329b017aa7c832',
      '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
      '0x4f922d5b15e6691e0469663e4f5c4177f23c5faf',
      '0xee04c68742e6bf434be8039580d2e89bbe55bc6f',
      '0xeaea9253a0b75b936a965dbd35b2a3f01831de74',
      '0x57fc55f719df19b4b90a03f9d78e1177d002e504'
    ],
    true,
    'addresses from developer.pancakeswap.finance v3 and Infinity address pages (Robinhood column). x_url not set: no X link found on PancakeSwap pages checked. contracts, in order: v3 PancakeV3Factory, v3 PancakeV3PoolDeployer, v3 NonfungiblePositionManager, v3 QuoterV2, v3 SmartRouter, Infinity Vault, Infinity CLPoolManager, Infinity CLPositionManager, Infinity UniversalRouter.'),
  ('robinhood', 'ekubo', 'Ekubo', 'dex',
    'Singleton concentrated-liquidity AMM (Ekubo V3) with TWAMM orders and MEV-capture extensions.',
    'https://ekubo.org', 'https://x.com/EkuboProtocol', null,
    array[
      '0x00000000000014aa86c5d3c41765bb24e11bd701',
      '0x5555ff9ff2757500bf4ee020dcfd0210cffa41be',
      '0x517e506700271aea091b02f42756f5e174af5230',
      '0xd47f1b1edcfeabb08f6ebd8fc337c27e636c75ba',
      '0x02d9876a21af7545f8632c3af76ec90b5ad4b66d',
      '0x3325428adb409c239e88ca472f50b0efe00e98b4'
    ],
    true,
    'docs.ekubo.org evm-v3 reference: same addresses on every chain; Robinhood Chain listed Live with the original (v3.1.1) managers only. contracts, in order: Core, MEVCapture, Oracle, TWAMM, Positions (original v3.1.1), Orders (original v3.1.1).'),
  ('robinhood', 'arcus', 'Arcus', 'dex',
    'Exchange for stock tokens, crypto and perpetuals built by the dYdX team, with spot settlement on Robinhood Chain.',
    'https://arcus.xyz', 'https://x.com/arcus_xyz', null,
    '{}',
    false,
    'no contract addresses published in Arcus docs found; positions are held on the Arcus appchain with deltas recorded on Robinhood Chain.'),
  ('robinhood', 'bags', 'Bags', 'launchpad',
    'Permissionless token launchpad: bonding curve that graduates to a Uniswap v4 pool.',
    'https://bags.fm', 'https://x.com/BagsApp', null,
    array[
      '0xe8cc4431adf8b5a847c113ef0c6af9043219cb37',
      '0xc82db941daf90b754aecb5f7d14c683dc608d595',
      '0x2380abf72c17aabab76480244759ac7e2932eecc',
      '0x4861446aa7ffd9e67a83cbbacb1a4b70540b83aa'
    ],
    true,
    'addresses from docs.bags.fm/robinhood/contracts. contracts, in order: BagsFactory (proxy), BagsLens, BagsV4Hook, BagsVault (proxy).'),
  ('robinhood', 'pons', 'pons', 'launchpad',
    'Token launchpad: each launch goes straight into a locked 1% Uniswap v3 WETH pool (no bonding curve).',
    'https://ponsfamily.com', 'https://x.com/ponsdotfamily', null,
    array[
      '0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb',
      '0x736d76699c26d0d966744cae304c000d471f7f35',
      '0x0c37a24f5d23a486fa692d1500881d698b1f77a4'
    ],
    true,
    'addresses from docs.ponsfamily.com. third-party lists (envio) give 0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e as a pons bonding-curve contract; not in pons docs, so not included. contracts, in order: Active factory, Active locker, Legacy factory.'),
  ('robinhood', 'doppler', 'Doppler', 'launchpad',
    'Token launch protocol that other launchpads build on (price discovery and liquidity bootstrapping).',
    'https://doppler.lol', 'https://x.com/dopplerprotocol', null,
    array[
      '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862',
      '0xf45588e8e0b1df9db9ae7e20ece5726ae931357c',
      '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544',
      '0x6cce158b6d1747617fc218592b4d60b239b957ea'
    ],
    true,
    'addresses from docs.doppler.lol contract-addresses, Robinhood Mainnet (4663). contracts, in order: Airlock, Bundler, DopplerHookInitializer, UniswapV4Initializer.'),
  ('robinhood', 'morpho', 'Morpho', 'lending',
    'Lending markets and vaults; powers USDG yield behind Robinhood Earn.',
    'https://morpho.org', 'https://x.com/Morpho', null,
    array[
      '0x9d53d5e3bd5e8d4cbfa6db1ca238aea02e651010',
      '0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1',
      '0x0fbad98595b0186da120e41f77c102beb49f803c',
      '0xe785a2efd384ba7b95baed3851bc76aed67c676f',
      '0xce5c1afa115ff8b1d6913509bfc79d9ae08cc857'
    ],
    true,
    'addresses from docs.morpho.org addresses page, Robinhood Chain tabs. contracts, in order: Morpho (Blue), AdaptiveCurveIrm, VaultV2Factory, MorphoRegistry, Blue Public Allocator.'),
  ('robinhood', 'canonical-bridge', 'Robinhood Chain Bridge', 'bridge',
    'Canonical Arbitrum bridge between Ethereum and Robinhood Chain: trustless, ~10 min deposits, 7-day withdrawals.',
    'https://portal.arbitrum.io/bridge?destinationChain=robinhood-chain&sourceChain=ethereum', null, null,
    array[
      '0x1e324b9316138ca9a73f960213621ad1aaf01b89',
      '0xfd9b17206278c16ddaacf6ac8f05dbf97edcb31e',
      '0x912285144fc0f6e89d3ed16f5ab72f87a1878959',
      '0x1d187c3e2da52d72bc9c41e3aba0fdfa6a7bf055'
    ],
    true,
    'L2 addresses from docs.robinhood.com/chain/protocol-contracts. L1 (Ethereum): Delayed Inbox 0x1a07cc4bd17e0118bdb54d70990d2158abad7a2d, Bridge 0xdf8755334ce7a73ccf6b581c02ea649ae3e864b3, Outbox 0xf0ce991ea4a0d2400a4ab49b20ae333f6dce3de9, Rollup 0x23a19d23e89166adedbdcb432518ab01e4272d94, L1 Gateway Router 0x6a2e3a1e16fc29f27ce61429746d558d656975bb. contracts, in order: L2 Gateway Router, L2 ERC20 Gateway, L2 Arb-Custom Gateway, L2 Weth Gateway.'),
  ('robinhood', 'across', 'Across', 'bridge',
    'Intent-based bridge; listed in the official Robinhood Chain bridging docs.',
    'https://across.to', null, null,
    array[
      '0xd29c85f15df544ba632c9e25829fd29d767d7978',
      '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4'
    ],
    true,
    'addresses from docs.across.to contract-addresses (Robinhood, 4663). x_url not set: no X link found on Across pages checked. contracts, in order: SpokePool, Periphery.'),
  ('robinhood', 'relay', 'Relay', 'bridge',
    'Intent-based bridge with bridge-and-execute; listed in the official Robinhood Chain bridging docs.',
    'https://relay.link', 'https://x.com/RelayProtocol', null,
    '{}',
    false,
    'Robinhood Chain not listed on Relay address pages checked. third-party lists (envio) give 0x4cd00e387622c35bddb9b4c962c136462338bc31; unconfirmed, not included.'),
  ('robinhood', 'layerzero', 'LayerZero', 'infrastructure',
    'Cross-chain messaging and OFT token transfers (Stargate route in the official bridging docs).',
    'https://layerzero.network', 'https://x.com/LayerZero_Core', null,
    array[
      '0x6f475642a6e85809b1c36fa62763669b1b48dd5b',
      '0xc39161c743d0307eb9bcc9fef03eeb9dc4802de7',
      '0xe1844c5d63a9543023008d332bd3d2e6f1fe1043',
      '0x4208d6e27538189bb48e603d6123a94b8abe0a0b'
    ],
    true,
    'addresses from LayerZero metadata API (chainKey robinhood, eid 30416). contracts, in order: EndpointV2, SendUln302, ReceiveUln302, Executor.'),
  ('robinhood', 'chainlink', 'Chainlink', 'infrastructure',
    'Official oracle for Robinhood Chain: data feeds for stock tokens and CCIP cross-chain transfers.',
    'https://chain.link', 'https://x.com/chainlink', null,
    array[
      '0x06fc836cf9839b1cd891c440a0a45242da6ae1c9',
      '0x1912c3cfafe8a76a32a92861d815ac2837f237ca'
    ],
    true,
    'addresses from docs.chain.link CCIP directory (robinhood-mainnet, chain selector 6180753054346818345). price feed addresses are per-feed and not listed here. contracts, in order: CCIP Router, CCIP TokenAdminRegistry.'),
  ('robinhood', 'blockscout', 'Blockscout', 'explorer',
    'Block explorer for Robinhood Chain, linked from the official docs.',
    'https://robinhoodchain.blockscout.com', 'https://x.com/blockscout', null,
    '{}',
    false,
    'explorer, no contracts. is_verified false only because there is no contract address to confirm.')
on conflict (chain, slug) do nothing;

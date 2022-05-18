const sdk = require("@defillama/sdk");
const BigNumber = require("ethers").BigNumber;
const {
  getRatio,
  multiplyByRatio,
  sumBalances,
  getAddressOnChain,
  sumMultiBalances,
  getTokenAddressOnChain,
  getStakingPoolsPendingRewardsBalances,
  getFarmPendingTokensBalances,
} = require("./utils");
const userInfoAbi = require("../helper/abis/userInfo.json");
const getReservesAbi = require("../helper/abis/getReserves.json");
const { config, getToken, getFarm, getLiquidityPool } = require("./config");

const chain = config.chains["cronos"];

async function getStakingBalances(timestamp, chainBlocks) {
  const balances = {};
  const versa = getToken("versa", chain.id);
  const xversa = getToken("xversa", chain.id);
  const vvs = getToken("vvs", chain.id);
  const xvvs = getToken("xvvs", chain.id);

  // how much holding token (xVVS) VersaGames has in each SP
  const stakingBalances = (
    await sdk.api.abi.multiCall({
      abi: { ...userInfoAbi, inputs: [userInfoAbi.inputs[1]] },
      calls: config.stakingPools.map((sp) => ({
        target: sp.contractAddresses[chain.id],
        params: [config.treasuryAddress],
      })),
      chain: chain.name,
      block: chainBlocks[chain.name],
      requery: true,
    })
  ).output;

  // total supply of xVVS
  const xvvsTotalSupply = (
    await sdk.api.abi.call({
      target: xvvs.address,
      params: [],
      abi: "erc20:totalSupply",
      chain: chain.name,
      block: chainBlocks[chain.name],
    })
  ).output;

  const totalStakedBalanceResults = (
    await sdk.api.abi.multiCall({
      abi: "erc20:balanceOf",
      calls: [
        { target: vvs.address, params: [xvvs.address] }, // Total VVS staked
        { target: versa.address, params: [xversa.address] }, // Total VERSA staked
      ],
      block: chainBlocks[chain.name],
      chain: chain.name,
      requery: true,
    })
  ).output;

  const xvvsToVvsRatio = getRatio(
    {
      amount: BigNumber.from(totalStakedBalanceResults[0].output),
      decimals: vvs.decimals,
    },
    { amount: BigNumber.from(xvvsTotalSupply), decimals: xvvs.decimals }
  );

  // convert xVVS to VVS as xVVS has no price, using calculated ratio, then sum balances from all SP
  const versaGamesTotalStakedVVS = stakingBalances.reduce((bal1, bal2) =>
    multiplyByRatio(BigNumber.from(bal1.output.amount), xvvsToVvsRatio).add(
      multiplyByRatio(BigNumber.from(bal2.output.amount), xvvsToVvsRatio)
    )
  );

  // get pending rewards for each SP
  const otherBalances = await getStakingPoolsPendingRewardsBalances(
    chain,
    chainBlocks[chain.name]
  );

  otherBalances.push({
    token: getAddressOnChain(vvs.address, chain),
    balance: versaGamesTotalStakedVVS.toString(),
  });

  // VersaGames owned staking
  otherBalances.push({
    token: getAddressOnChain(versa.address, chain),
    balance: totalStakedBalanceResults[1].output,
  });

  sumMultiBalances(balances, otherBalances);

  return balances;
}

async function getTreasuryBalances(timestamp, chainBlocks) {
  const balances = {};
  const tokensOfInterest = ["versa", "usdc", "single"];

  const multiCalls = [];

  tokensOfInterest.map((tokenId) => {
    // treasury wallet
    const targetAddress = getToken(tokenId, chain.id).address;
    multiCalls.push({
      target: targetAddress,
      params: [config.treasuryAddress],
    });
    // DEV funds wallet
    multiCalls.push({
      target: targetAddress,
      params: [config.opsAddress],
    });
  });

  const treasuryTokenBalanceResults = await sdk.api.abi.multiCall({
    abi: "erc20:balanceOf",
    calls: multiCalls,
    chain: chain.name,
    block: chainBlocks[chain.name],
    requery: true,
  });

  sdk.util.sumMultiBalanceOf(
    balances,
    treasuryTokenBalanceResults,
    true,
    (addr) => `${chain.name}:${addr}`
  );

  return balances;
}

async function getPoolsBalances(timestamp, chainBlocks) {
  const balances = {};
  const otherBalances = [];
  const versaUsdcLP = getLiquidityPool("versa-usdc-lp");
  const versaVvsLP = getLiquidityPool("versa-vvs-lp");

  // VERSA - USDC LP balance
  const versaUsdcLPBalance = (
    await sdk.api.abi.call({
      target: versaUsdcLP.contractAddresses[chain.id],
      params: [config.treasuryAddress],
      abi: "erc20:balanceOf",
      chain: chain.name,
      block: chainBlocks[chain.name],
    })
  ).output;

  // VERSA - VVS Farm balance
  const versaVVSFarmBalance = (
    await sdk.api.abi.call({
      target: getFarm("craftsman-v2").contractAddresses[chain.id],
      params: [versaVvsLP.farmPoolId, config.treasuryAddress],
      abi: userInfoAbi,
      chain: chain.name,
      block: chainBlocks[chain.name],
    })
  ).output;

  const lpsData = [
    {
      lp: versaUsdcLP,
      balance: BigNumber.from(versaUsdcLPBalance),
      balanceRatio: 0,
    },
    {
      lp: versaVvsLP,
      balance: BigNumber.from(versaVVSFarmBalance.amount),
      balanceRatio: 0,
    },
  ];

  // Get LPs total supply
  const totalSupplyResults = (
    await sdk.api.abi.multiCall({
      abi: "erc20:totalSupply",
      calls: config.liquidityPools.map((lp) => ({
        target: lp.contractAddresses[chain.id],
        params: [],
      })),
      block: chainBlocks[chain.name],
      chain: chain.name,
      requery: true,
    })
  ).output;

  // Get LPs total token0 and token1 reserves
  const lpTokensReservesResult = (
    await sdk.api.abi.multiCall({
      abi: getReservesAbi,
      calls: config.liquidityPools.map((lp) => ({
        target: lp.contractAddresses[chain.id],
        params: [],
      })),
      block: chainBlocks[chain.name],
      chain: chain.name,
      requery: true,
    })
  ).output;

  lpsData.map((lpData) => {
    const lpAddress = lpData.lp.contractAddresses[chain.id];
    const tokenSupply = totalSupplyResults.find(
      (r) => r.input.target === lpAddress
    );
    const lpTokensReserves = lpTokensReservesResult.find(
      (r) => r.input.target === lpAddress
    );

    // Calculate ratio between balance and total supply
    const balanceRatio = getRatio(
      {
        amount: lpData.balance,
        decimals: 18,
      },
      {
        amount: BigNumber.from(tokenSupply.output),
        decimals: 18,
      }
    );

    // multiply token0 reserves by balanceRatio
    otherBalances.push({
      token: getTokenAddressOnChain(lpData.lp.token0, chain),
      balance: multiplyByRatio(
        BigNumber.from(lpTokensReserves.output["0"]),
        balanceRatio
      ).toString(),
    });
    // multiply token1 reserves by balanceRatio
    otherBalances.push({
      token: getTokenAddressOnChain(lpData.lp.token1, chain),
      balance: multiplyByRatio(
        BigNumber.from(lpTokensReserves.output["1"]),
        balanceRatio
      ).toString(),
    });
  });

  const farmPendingTokensBalances = await getFarmPendingTokensBalances(
    getFarm("craftsman-v2"),
    versaVvsLP.farmPoolId,
    chain,
    chainBlocks[chain.name]
  );

  sumMultiBalances(balances, otherBalances.concat(farmPendingTokensBalances));
  return balances;
}

async function tvl(timestamp, ethBlock, chainBlocks) {
  const balances = await getTreasuryBalances(timestamp, chainBlocks);
  const stakingBalances = await getStakingBalances(timestamp, chainBlocks);
  const pool2Balances = await getPoolsBalances(timestamp, chainBlocks);

  sumBalances(balances, stakingBalances);
  sumBalances(balances, pool2Balances);

  return balances;
}

module.exports = {
  timetravel: true,
  cronos: {
    pool2: getPoolsBalances,
    treasury: getTreasuryBalances,
    staking: getStakingBalances,
    tvl: tvl,
  },
  methodology:
    "TVL is calculated as sum of the following values: value of staked tokens; value of tokens in treasury wallet; value of tokens in dev funds wallet; value of tokens in LPs and Farms, also their rewards",
};

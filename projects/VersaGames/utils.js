const sdk = require("@defillama/sdk");
const BigNumber = require("ethers").BigNumber;
const {
  config,
  getToken,
  getStakingPoolByAddressAndChain,
} = require("./config");
const pendingRewardAbi = require("./abi/pendingReward.json");
const pendingTokensAbi = require("./abi/pendingTokens.json");

const getRatio = (amount1, amount2, precision = 5) => {
  const [amount1Scaled, amount2Scaled] = scaleAmounts([amount1, amount2]);
  return {
    value:
      amount1Scaled.amount
        .mul(BigNumber.from(10).pow(precision))
        .div(amount2Scaled.amount)
        .toNumber() / Math.pow(10, precision),
    precision,
  };
};

const multiplyByRatio = (number, multiplier) => {
  const multiplyBy = BigNumber.from(
    Math.round(multiplier.value * Math.pow(10, multiplier.precision))
  );
  return number
    .mul(multiplyBy)
    .div(BigNumber.from(10).pow(multiplier.precision));
};

/**
 * Returns the amounts scaled to the maximum number of decimals
 */
const scaleAmounts = (amounts) => {
  const maxDecimals = Math.max(...amounts.map((a) => a.decimals));
  return amounts.map((a) => ({
    amount: scaleAmount(a.amount, a.decimals, maxDecimals),
    decimals: maxDecimals,
  }));
};

const scaleAmount = (amount, amountDecimals, newDecimals) => {
  const scaleDiff = newDecimals - amountDecimals;
  if (!scaleDiff) {
    return amount;
  }
  const scaleFactor = BigNumber.from(10).pow(Math.abs(scaleDiff));
  if (scaleDiff < 0) {
    return amount.div(scaleFactor);
  }
  return amount.mul(scaleFactor);
};

function sumBalances(bal1, bal2) {
  for (const balance in bal2) {
    if (bal1[balance] !== undefined) {
      const tokenBalanceInBal1 = BigNumber.from(bal1[balance]);
      bal1[balance] = tokenBalanceInBal1
        .add(BigNumber.from(bal2[balance]))
        .toString();
    }
    if (bal1[balance] === undefined) {
      bal1[balance] = bal2[balance];
    }
  }
}

function sumMultiBalances(balances, otherBalances) {
  otherBalances.forEach((b) => {
    sdk.util.sumSingleBalance(balances, b.token, b.balance);
  });
}

function getAddressOnChain(address, chain) {
  return `${chain.name}:${address}`;
}

function getTokenAddressOnChain(tokenId, chain) {
  const token = getToken(tokenId, chain.id);
  return `${chain.name}:${token.address}`;
}

async function getStakingPoolsPendingRewardsBalances(chain, block) {
  const pendingRewardsBalances = [];

  const pendingRewards = (
    await sdk.api.abi.multiCall({
      abi: pendingRewardAbi,
      calls: config.stakingPools.map((sp) => ({
        target: sp.contractAddresses[chain.id],
        params: [config.treasuryAddress],
      })),
      chain: chain.name,
      block: block,
      requery: true,
    })
  ).output;

  pendingRewards.forEach((r) => {
    const rewardTokenAddress = getToken(
      getStakingPoolByAddressAndChain(r.input.target, chain.id).rewardToken,
      chain.id
    ).address;
    pendingRewardsBalances.push({
      token: getAddressOnChain(rewardTokenAddress, chain),
      balance: r.output,
    });
  });

  return pendingRewardsBalances;
}

async function getFarmPendingTokensBalances(farm, pId, chain, block) {
  const pendingTokensBalances = [];
  const pendingTokensResults = (
    await sdk.api.abi.call({
      abi: pendingTokensAbi,
      target: farm.contractAddresses[chain.id],
      params: [pId, config.treasuryAddress],
      block: block,
      chain: chain.name,
    })
  ).output;

  pendingTokensResults[0].forEach((tokenAddress, index) => {
    pendingTokensBalances.push({
      token: getAddressOnChain(tokenAddress, chain),
      balance: pendingTokensResults[1][index],
    });
  });

  return pendingTokensBalances;
}

module.exports = {
  getRatio,
  multiplyByRatio,
  sumBalances,
  getAddressOnChain,
  sumMultiBalances,
  getTokenAddressOnChain,
  getStakingPoolsPendingRewardsBalances,
  getFarmPendingTokensBalances,
};

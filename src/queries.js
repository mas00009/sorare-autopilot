/**
 * GraphQL documents, grounded in reference/schema.graphql.
 * Field paths verified against the live schema on 2026-09-21.
 */

const ODDS = `
  starterOddsBasisPoints
  substituteOddsBasisPoints
  nonPlayingOddsBasisPoints
  reliability
`;

/** Currency balances - the guardrail reads gems from here. */
export const Q_BALANCES = `
  query Balances($sport: Sport!) {
    currentUser {
      nickname
      inGameCurrencyBalances(sport: $sport) { currency amount cap }
    }
  }
`;

/** The Set ladder: live step plus the squad. */
export const Q_TRACK = `
  query Track($sport: Sport!) {
    currentUser {
      nickname
      squad(sport: $sport) { id name }
      setTasksTrack(sport: $sport) {
        aasmState
        currentStep { id }
      }
      setLiveTasksTrackStep(sport: $sport) { id }
    }
  }
`;

/** A step, its rules, target and my current lineup for it. */
export const Q_STEP = `
  query Step($id: String!) {
    currentUser {
      step(id: $id) {
        id
        level
        state
        target
        collaborative
        # What the armband is worth on this step, from Sorare rather than a
        # constant of ours. It has read 0.5 on both boards so far.
        engineConfiguration { captain }
        # A squad step is collaborative: it needs a minimum number of lineups
        # from the squad before it starts at all, and the target is the sum of
        # everyone's scores rather than one lineup's.
        ... on SquadStep { totalLineups totalScore minimumLineupsToStartStep }
        rewardConfigs {
          __typename
          ... on CardPacksRewardConfig { cardPack { slug cardsCount currency effectivePrice } }
          ... on CardShardRewardConfig { quantity rarity }
        }
        myLineups {
          id
          updatable
          ... on TaskLineupInterface {
            score
            aasmState
            taskAppearances {
              index
              captain
              locked
              lockedAt
              position
              pictureUrl(derivative: "tinified")
              anyCard { slug }
              anyPlayer {
                slug
                displayName
                activeInjuries { active kind }
                anyFutureGameStats(first: 1) { anyGame { id date } }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Eligible bench for a step.
 * Note the defaults we rely on: includeUnavailablePlayers defaults to false,
 * so injured and suspended players are excluded by Sorare, not by us.
 * includeNoGame defaults to false, so every card returned has a real fixture.
 */
export const Q_BENCH = `
  query Bench($id: String!, $filters: BenchFilterInput!, $first: Int!) {
    currentUser {
      step(id: $id) {
        id
        myFilteredBench(filters: $filters, first: $first) {
          nodes {
            id
            position
            positions
            rarity
            bonus
            pictureUrl(derivative: "tinified")
            averageScore(type: LAST_FIFTEEN_SO5_AVERAGE_SCORE)
            formL5: averageScore(type: LAST_FIVE_SO5_AVERAGE_SCORE)
            player {
              slug
              displayName
              activeInjuries { active kind status expectedEndDate }
              anyFutureGameStats(first: 1) {
                onGameSheet
                anyTeam { slug name __typename }
                anyGame {
                  id
                  date
                  competition { name }
                  homeTeam { slug name ... on Club { code domesticLeagueRanking } ... on NationalTeam { code } }
                  awayTeam { slug name ... on Club { code domesticLeagueRanking } ... on NationalTeam { code } }
                }
                ... on PlayerGameStats {
                  footballPlayingStatusOdds(newVersion: true) { ${ODDS} }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** Submit or update a step lineup. */
export const M_UPSERT_STEP_LINEUP = `
  mutation UpsertStepLineup($input: upsertStepLineupInput!) {
    upsertStepLineup(input: $input) {
      errors { message path }
      lineup {
        id
        ... on TaskLineupInterface {
          taskAppearances { index captain anyPlayer { slug displayName } }
        }
      }
    }
  }
`;

/** Missions: daily run, play tasks, collections, featured dailies. */
const TASK_FIELDS = `
  id
  name
  description
  aasmState
  completedAt
  claimableAt
`;

export const Q_MISSIONS = `
  query Missions($sport: Sport!) {
    currentUser {
      myUnclaimedTasksCount(sport: $sport)
      dailyRunTask(sport: $sport) { ${TASK_FIELDS} }
      setPlayTasks(sport: $sport, first: 20) { ${TASK_FIELDS} }
      featuredTasks(sport: $sport) { ${TASK_FIELDS} }
      # The four daily checklist items live here and nowhere else. They are
      # absent from setPlayTasks, featuredTasks and dailyRunTask, which is why
      # claimable missions went unseen for so long.
      dailies: tasks(periodicity: DAILY, sport: $sport) {
        id name title description aasmState
        # Daily Boost gates on all four checklist items, and its own progress/target
        # reads a meaningless 3/1. liveScore against scoreToReach is the real gate.
        ... on DailyActionTask { liveScore scoreToReach }
      }
      weeklies: tasks(periodicity: WEEKLY, sport: $sport) { id name title description aasmState }
      setCollectionsTaskTracks(sport: $sport, first: 25) {
        ${TASK_FIELDS}
        ... on TasksTrack { currentStep { ${TASK_FIELDS} } }
      }
    }
  }
`;

export const M_CLAIM_TASK = `
  mutation ClaimTask($input: claimTaskInput!) {
    claimTask(input: $input) { errors { message } }
  }
`;

export const M_CLAIM_STEP = `
  mutation ClaimStep($input: claimStepInput!) {
    claimStep(input: $input) { errors { message } }
  }
`;

/** Both Set boards: CAREER is your own ladder, SQUAD is the team one. */
export const Q_BOARDS = `
  query Boards($sport: Sport!) {
    currentUser {
      nickname
      squad(sport: $sport) { id name }
      career: setBoard(mode: CAREER, sport: $sport) {
        id title
        myCurrentStep {
          id state target level
          # The hearts. The step's own task is a ThresholdPickerTask, and that is
          # the only place the lives live - nothing on the board or step carries
          # them. A squad step is collaborative and has none.
          ... on CareerStep {
            myTask { ... on ThresholdPickerTask { maxLineupsCount remainingLineupsCount } }
          }
        }
        steps { id level state target }
      }
      team: setBoard(mode: SQUAD, sport: $sport) {
        id title myCurrentStep { id state target level } steps { id level state target }
      }
    }
  }
`;

/** Essence balance lives on the common card-shards chest, not in currency balances. */
export const Q_ESSENCE = `
  query Essence($sport: Sport!) {
    currentUser {
      cardShardsChests(sport: $sport, rarities: [common]) { id rarity cardShardsCount }
    }
  }
`;

/** The essence-priced pack Sorare currently offers. */
export const Q_PACK = `
  query Pack($sport: Sport!) {
    market {
      recommendedCardPack(sport: $sport) {
        slug currency effectivePrice price canPurchase cardsCount
      }
    }
  }
`;

export const M_BUY_PACK = `
  mutation BuyCardPack($input: buyCardPackInput!) {
    buyCardPack(input: $input) {
      errors { message }
      pack { id }
      cards { slug anyPlayer { slug displayName gameplayTier } }
    }
  }
`;

export const M_CLAIM_PACK = `
  mutation ClaimCardsFromPack($input: claimCardsFromPackInput!) {
    claimCardsFromPack(input: $input) { errors { message } pack { id } }
  }
`;

export const M_RESTART_TRACK = `
  mutation RestartTasksTrack($input: restartTasksTrackInput!) {
    restartTasksTrack(input: $input) {
      errors { message }
      newTask { id name aasmState }
    }
  }
`;

/** Replaces the deprecated claimStep. Returns what the step granted. */
export const M_ACK_STEP = `
  mutation AcknowledgeStep($input: acknowledgeStepInput!) {
    acknowledgeStep(input: $input) {
      errors { message }
      step { id state }
      rewards {
        __typename
        ... on AnyCardReward { card { slug anyPlayer { displayName gameplayTier } } }
        ... on CardShardsReward { quantity rarity }
        ... on InGameCurrencyReward { coinAmount }
        ... on CardPackReward { pack { id } }
      }
    }
  }
`;

/** Free daily packs arrive as probabilistic bundles ("wheel rewards"). */
export const Q_BUNDLES = `
  query Bundles($sport: Sport!) {
    currentUser {
      myWheelRewards(sport: $sport) {
        nodes { id aasmState probabilisticBundle { id isOpenable opened openableAt } }
      }
      claimablePacks(sport: $sport) { id }
    }
  }
`;

export const M_OPEN_BUNDLE = `
  mutation OpenBundle($input: probabilisticBundlesOpenInput!) {
    probabilisticBundlesOpen(input: $input) {
      errors { message }
      probabilisticBundle {
        id opened
        items { __typename ... on ProbabilisticBundleSlotCardItem { card { slug anyPlayer { displayName gameplayTier } } } }
      }
    }
  }
`;

/**
 * The daily free pack and the wheel live on MarketRoot, not CurrentUser.
 * Looking for them under currentUser is why they were invisible for so long:
 * every task query there returns them as absent rather than as an error.
 */
export const Q_MARKET_TASKS = `
  query MarketTasks($sport: Sport!, $rarity: Rarity!) {
    market {
      myCommonDailyClaimTask(sport: $sport) {
        id name title description aasmState progress target
      }
      myWheelTasks(sport: $sport, rarity: $rarity) {
        id name title description aasmState progress target
      }
      # The bonus pack after every 10 is a per-group counter, not a wheel task.
      # It must be claimed before the next pack in that group is opened or the
      # counter stops advancing.
      setSections(sport: $sport) {
        ... on CardPackGroup {
          slug
          title
          boughtPacksCountTask { id name title aasmState progress target }
        }
      }
    }
  }
`;

/**
 * How often a player has been starting. Used as the availability prior when
 * Sorare has not yet published starter odds for a fixture - which is the
 * whole of the early window, when the lock-day choice is made. Replaying 44
 * past rounds, this lifted the share of lineups clearing 300 from 20% to 33%.
 */
export const Q_START_RATES = `
  query StartRates($slugs: [String!]) {
    players(slugs: $slugs) {
      slug
      anyGameStats(last: 10) {
        playedInGame
        ... on PlayerGameStats { gameStarted }
      }
    }
  }
`;

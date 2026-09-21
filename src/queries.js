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
        displayedTypedRules { __typename }
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
            averageScore(type: LAST_FIFTEEN_SO5_AVERAGE_SCORE)
            formL5: averageScore(type: LAST_FIVE_SO5_AVERAGE_SCORE)
            player {
              slug
              displayName
              activeInjuries { active kind status expectedEndDate }
              anyFutureGameStats(first: 1) {
                onGameSheet
                anyTeam { slug name }
                anyGame {
                  id
                  date
                  competition { name }
                  homeTeam { slug name }
                  awayTeam { slug name }
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
      career: setBoard(mode: CAREER, sport: $sport) { id title myCurrentStep { id state target level } }
      team:   setBoard(mode: SQUAD,  sport: $sport) { id title myCurrentStep { id state target level } }
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

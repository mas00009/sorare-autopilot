import assert from 'node:assert/strict';
import { dnpReason, planSwaps } from '../src/guard.js';

const node = (o = {}) => ({ activeSuspensions: [], player: { activeInjuries: [], anyFutureGameStats: [{ anyGame: { id: 'g' }, footballPlayingStatusOdds: o.bp != null ? { starterOddsBasisPoints: o.bp } : null }], ...o.player } });
assert.equal(dnpReason(node()), null, 'no odds yet is not a DNP');
assert.equal(dnpReason(node({ bp: 8500 })), null);
assert.match(dnpReason(node({ bp: 3000 })), /30% to start/);
assert.match(dnpReason(node({ player: { activeInjuries: [{ active: true, kind: 'hamstring' }] } })), /injured/);
assert.match(dnpReason({ ...node(), activeSuspensions: [{}] }), /suspended/);

const c = (slug, position, expected, gameId, teamSlug, blocked = null) => ({ slug, player: slug, position, expected, gameId, teamSlug, blocked });
const five = [c('gk', 'GK', 60, 1, 'a'), c('df', 'DF', 60, 2, 'b'), c('md', 'MD', 60, 3, 'c'), c('fw', 'FW', 60, 4, 'd'), c('df2', 'DF', 60, 5, 'e')];
const bench = [c('mdX', 'MD', 70, 6, 'f'), c('dfY', 'DF', 65, 7, 'g'), c('dfBad', 'DF', 90, 8, 'h', 'injured'), c('opp', 'DF', 80, 3, 'z'), c('gk2', 'GK', 55, 9, 'i')];

// A defender out: like-for-like first, never a blocked card, never the other side of a match already in.
let p = planSwaps(five, [{ c: five[1], why: 'injured' }], bench);
assert.deepEqual(p.swaps, [{ out: 'df', why: 'injured', in: 'dfY' }]);
assert.equal(p.next.length, 5);
// The keeper out: only a keeper can replace him.
p = planSwaps(five, [{ c: five[0], why: 'only 20% to start' }], bench);
assert.equal(p.swaps[0].in, 'gk2');
// The only midfielder out: the five must stay legal, so a midfielder comes in.
p = planSwaps(five, [{ c: five[2], why: 'suspended' }], bench);
assert.equal(p.swaps[0].in, 'mdX');
// Nothing safe: reported, not forced.
p = planSwaps(five, [{ c: five[0], why: 'injured' }], bench.filter((x) => x.position !== 'GK'));
assert.equal(p.swaps[0].in, null);
console.log('guard assertions passed');

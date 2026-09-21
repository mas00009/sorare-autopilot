import assert from 'node:assert/strict';
import { samplesFor, evaluate } from '../src/backtest.js';

const g = (date, score, home) => ({ anyTeam:{slug:'t'}, anyGame:{ date,
  homeTeam:{slug: home?'t':'o'}, awayTeam:{slug: home?'o':'t'} },
  playedInGame:true, playerGameScore:{ score } });

const hist = [1,2,3,4,5,6,7,8].map((i)=>g(`2026-0${i}-01T12:00:00Z`, 50+i, i%2===0));
const s = samplesFor(hist);
// 8 games, first prediction at index 5 -> 3 samples.
assert.equal(s.length, 3, 'walk-forward starts after 5 games');
// No sample may see its own game: l5 of the first sample is games 1-5 only.
assert.equal(s[0].actual, 56);
assert.equal(s[0].l5, (51+52+53+54+55)/5);
assert.equal(s[0].l15, (51+52+53+54+55)/5);

// Unplayed games with no score are dropped, not counted as zero.
const withGap = [...hist, { anyTeam:{slug:'t'}, anyGame:{date:'2026-09-01T12:00:00Z'}, playedInGame:false, playerGameScore:null }];
assert.equal(samplesFor(withGap).length, 3, 'a null score adds no sample');

// A perfect predictor scores zero error.
const flat = [{ actual: 60, home:false, l5:60, l15:60 }];
const e = evaluate(flat, { formWeight:0.4, homeAdvantage:1.03 });
assert.equal(e.rmse, 0); assert.equal(e.bias, 0);

// Home advantage over-predicts a home game that scored the same.
const homeS = [{ actual: 60, home:true, l5:60, l15:60 }];
assert.ok(evaluate(homeS, { formWeight:0.4, homeAdvantage:1.03 }).bias < 0, 'over-projection reads negative');
console.log('backtest assertions passed');

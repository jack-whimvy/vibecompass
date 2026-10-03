#!/usr/bin/env python3
"""Operating characteristics of the A7 no-regression rules (recall plan task A7;
recall-evaluation.md › A7 protocol › gate 4). Development tool; not shipped in the
npm package. Python 3 standard library only.

    python3 scripts/simulate-a7-noregression.py [--trials 1000] [--seed 20261002]

What it models. Each simulated evaluation has 15 positive tasks: the 9 tuning
positives with the real item/clause structure of their labels, and 6 held-out-like
tasks whose structures are drawn from those nine (the held-out labels are never
read). Each clause has a probability that a run's report states it, drawn from a
Beta distribution with mean near A5's 0.89 baseline rate (three shapes, from
concentrated to dispersed). Both arms share these probabilities unless an effect
is applied to the brief arm. An item scores 1 when all its clauses are stated,
0.5 when some are, 0 when none (attribution is assumed).

Variants (assumptions the results depend on):
- independent: clauses, runs, and grading are independent; grading is perfect.
- run-quality: each run shifts every clause probability by a shared amount on the
  logit scale (normal, sd 0.5), so a run is good or bad as a whole.
- grader-error: each final clause verdict is flipped with probability 0.03 (the
  residual error after majority grading; an assumption, not a measurement).

Rules: the first pre-registered clause rule (baseline 3/3, brief at most 1/3),
that rule plus 2/3 -> 0/3, and the adopted two-stage rule (stage-1 screen, three
more replicates for flagged tasks, confirmation, and the split guard on final
task means), with the thresholds of the harness's REGRESSION constant. `gate`
mirrors the harness's scorer; `--self-test` runs a deterministic parity control
that also runs before every simulation.

Effects on the brief arm: none (false-alarm rate), one clause collapsing to 0.1,
a T3-like collapse of four clauses in one task, and every clause 0.10 lower.
Each (distribution, variant, effect) cell uses its own seed derived from --seed,
so any cell reproduces alone.
"""
import argparse
import math
import random
import statistics

TUNING = [[3, 2, 2, 3], [2, 2, 1, 1], [2, 3, 3, 2], [2, 2, 2, 2, 2], [2, 1, 2, 1], [2, 2, 3, 1, 3], [3, 2, 2, 4, 3, 1, 2], [2, 2, 1, 2], [1, 2, 2, 2, 2]]
DISTRIBUTIONS = {"concentrated Beta(8,1)": (8, 1), "mid Beta(3,0.37)": (3, 0.37), "dispersed Beta(1.5,0.19)": (1.5, 0.19)}
REGRESSION = dict(screen_task_drop=0.15, max_flagged=5, confirm_task_drop=0.15, confirm_baseline_min=5, confirm_brief_max=1, split_drop=0.05)


def logit(p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return math.log(p / (1 - p))


def sigmoid(x):
    return 1 / (1 + math.exp(-x))


def item_score(states):
    stated = sum(states)
    return 1.0 if stated == len(states) else (0.5 if stated else 0.0)


def one_run(rng, task_probs, variant):
    shift = rng.gauss(0, 0.5) if variant == "run-quality" else 0.0
    items = []
    for item in task_probs:
        states = []
        for p in item:
            q = sigmoid(logit(p) + shift) if shift else p
            stated = rng.random() < q
            if variant == "grader-error" and rng.random() < 0.03:
                stated = not stated
            states.append(stated)
        items.append(states)
    return statistics.fmean(item_score(states) for states in items), items


def task_stats(runs_base, runs_brief, shape):
    drop = statistics.fmean(r[0] for r in runs_base) - statistics.fmean(r[0] for r in runs_brief)
    counts = []
    for i, n in enumerate(shape):
        for c in range(n):
            counts.append((sum(r[1][i][c] for r in runs_base), sum(r[1][i][c] for r in runs_brief)))
    return drop, counts


def gate(stage1, stage2, shapes):
    """The adopted two-stage gate, as the harness scores it (screenRows,
    confirmedLoss, summarize). stage1[t] = (baseline runs, brief runs), three
    each; stage2[t] = three more per arm for a flagged task, else None. A run is
    (recall, clause states). Split drops use each task's final means: six
    replicates for a confirmed-run task, three otherwise."""
    flagged, final_drops = [], []
    for t, (b, r) in enumerate(stage1):
        drop, counts = task_stats(b, r, shapes[t])
        if drop > REGRESSION["screen_task_drop"] + 1e-9 or any(cb >= 2 and cb - cr >= 2 for cb, cr in counts):
            flagged.append(t)
    systematic = len(flagged) > REGRESSION["max_flagged"]
    confirmed = False
    for t, (b, r) in enumerate(stage1):
        if not systematic and t in flagged and stage2[t] is not None:
            b, r = b + stage2[t][0], r + stage2[t][1]
            drop, counts = task_stats(b, r, shapes[t])
            if drop > REGRESSION["confirm_task_drop"] + 1e-9 or any(cb >= REGRESSION["confirm_baseline_min"] and cr <= REGRESSION["confirm_brief_max"] for cb, cr in counts):
                confirmed = True
        else:
            drop, _ = task_stats(b, r, shapes[t])
        final_drops.append(drop)
    split = statistics.fmean(final_drops[:9]) > REGRESSION["split_drop"] + 1e-9 or statistics.fmean(final_drops[9:]) > REGRESSION["split_drop"] + 1e-9
    return {"fails": split or systematic or confirmed, "flagged": flagged, "systematic": systematic, "confirmed": confirmed, "split": split}


def evaluate(rng, base, brief, variant):
    shapes = [[len(item) for item in task] for task in base]
    stage1 = [([one_run(rng, base[t], variant) for _ in range(3)], [one_run(rng, brief[t], variant) for _ in range(3)]) for t in range(len(base))]
    first_rule = first_rule_plus = False
    for t, (b, r) in enumerate(stage1):
        _, counts = task_stats(b, r, shapes[t])
        if any(cb == 3 and cr <= 1 for cb, cr in counts):
            first_rule = True
        if any((cb == 3 and cr <= 1) or (cb == 2 and cr == 0) for cb, cr in counts):
            first_rule_plus = True
    screened = gate(stage1, [None] * len(base), shapes)
    stage2 = [None] * len(base)
    if not screened["systematic"]:
        for t in screened["flagged"]:
            stage2[t] = ([one_run(rng, base[t], variant) for _ in range(3)], [one_run(rng, brief[t], variant) for _ in range(3)])
    outcome = gate(stage1, stage2, shapes)
    return {"first_rule": first_rule, "first_rule_plus_2to0": first_rule_plus, "two_stage": outcome["fails"], "extra_runs": 0 if outcome["systematic"] else 6 * len(outcome["flagged"])}


def self_test():
    """Deterministic parity control (reviewer pass 4, R11): 15 two-item positive
    tasks; three tuning tasks have baseline recall [1, 1, 1] and brief [1, 1, 0.5]
    in stage 1 and perfect confirmation runs; everything else is perfect. The
    stage-1 tuning drop (0.056) exceeds the split guard, but the final drop
    (0.028) does not, and no loss is confirmed: the gate passes, as the
    harness's scorer decides (src/tests/evaluate-brief-a7.test.js)."""
    perfect = (1.0, [[True], [True]])
    half = (0.5, [[True], [False]])
    shapes = [[1, 1]] * 15
    stage1 = [([perfect] * 3, [perfect, perfect, half] if t < 3 else [perfect] * 3) for t in range(15)]
    stage2 = [([perfect] * 3, [perfect] * 3) if t < 3 else None for t in range(15)]
    screened = gate(stage1, [None] * 15, shapes)
    assert screened["flagged"] == [0, 1, 2], screened
    assert screened["split"], "the stage-1 split drop alone would fail"
    outcome = gate(stage1, stage2, shapes)
    assert not outcome["confirmed"] and not outcome["split"] and not outcome["fails"], outcome
    print("self-test: parity control passes (stage-1 split would fail; final split and confirmation pass)")


def collapse_one(rng, brief):
    t = rng.randrange(len(brief))
    i = rng.randrange(len(brief[t]))
    c = rng.randrange(len(brief[t][i]))
    brief[t][i][c] = min(brief[t][i][c], 0.1)


def collapse_four(rng, brief):
    t = rng.randrange(len(brief))
    cells = [(i, c) for i, item in enumerate(brief[t]) for c in range(len(item))]
    for i, c in rng.sample(cells, min(4, len(cells))):
        brief[t][i][c] = min(brief[t][i][c], 0.1)


def diffuse(rng, brief):
    for task in brief:
        for item in task:
            for c in range(len(item)):
                item[c] = max(0.0, item[c] - 0.10)


EFFECTS = {"none (false alarm)": None, "one clause -> 0.1": collapse_one, "four clauses in one task -> 0.1": collapse_four, "every clause -0.10": diffuse}


def cell(seed, dist, variant, effect, trials):
    rng = random.Random(seed)
    totals = {"first_rule": 0, "first_rule_plus_2to0": 0, "two_stage": 0, "extra_runs": 0}
    for _ in range(trials):
        shapes = TUNING + [rng.choice(TUNING) for _ in range(6)]
        base = [[[rng.betavariate(*dist) for _ in range(n)] for n in shape] for shape in shapes]
        brief = [[list(item) for item in task] for task in base]
        if effect:
            effect(rng, brief)
        outcome = evaluate(rng, base, brief, variant)
        for key in totals:
            totals[key] += outcome[key]
    return {key: value / trials for key, value in totals.items()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--trials", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=20261002)
    parser.add_argument("--self-test", action="store_true", help="run only the deterministic parity control")
    args = parser.parse_args()
    self_test()
    if args.self_test:
        return
    print(f"trials per cell {args.trials}; base seed {args.seed}")
    print("| Distribution | Variant | Effect on brief arm | First rule fails | + 2/3->0/3 fails | Two-stage fails | Extra runs (mean) |")
    print("|---|---|---|---|---|---|---|")
    for d_index, (d_name, dist) in enumerate(DISTRIBUTIONS.items()):
        for v_index, variant in enumerate(["independent", "run-quality", "grader-error"]):
            for e_index, (e_name, effect) in enumerate(EFFECTS.items()):
                seed = args.seed * 1000 + d_index * 100 + v_index * 10 + e_index
                r = cell(seed, dist, variant, effect, args.trials)
                print(f"| {d_name} | {variant} | {e_name} | {r['first_rule']:.3f} | {r['first_rule_plus_2to0']:.3f} | {r['two_stage']:.3f} | {r['extra_runs']:.1f} |", flush=True)


if __name__ == "__main__":
    main()

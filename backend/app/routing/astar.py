"""A* on a NumPy cost grid, plus line-of-sight path smoothing.

`cost[row, col]` is a per-metre multiplier; `inf` means blocked.
"""

from __future__ import annotations

import heapq
import math
import time

import numpy as np

SQRT2 = math.sqrt(2.0)
# (d_row, d_col, length in cells)
MOVES = [
    (-1, 0, 1.0), (1, 0, 1.0), (0, -1, 1.0), (0, 1, 1.0),
    (-1, -1, SQRT2), (-1, 1, SQRT2), (1, -1, SQRT2), (1, 1, SQRT2),
]

Cell = tuple[int, int]


class SearchLimitExceeded(RuntimeError):
    """A* stopped at its node or time budget without proving anything."""

    def __init__(self, reason: str, expansions: int):
        super().__init__(reason)
        self.reason = reason
        self.expansions = expansions


def astar(
    cost: np.ndarray,
    start: Cell,
    goal: Cell,
    min_cost: float,
    max_expansions: int | None = None,
    time_limit_s: float | None = None,
    stats: dict | None = None,
    move_cost: tuple[list[int], list[list[float]]] | None = None,
) -> list[Cell] | None:
    """Cheapest 8-connected path, or None if unreachable.

    Step cost = step length (cells) x cost of the cell entered. Diagonal moves
    are only allowed when both orthogonal neighbours are free, so the path
    never squeezes between two blocked cells touching at a corner. The octile
    heuristic x min_cost never overestimates, so the result is optimal.
    Raises SearchLimitExceeded when a budget runs out (unproven either way).
    Flat Python lists are used instead of NumPy indexing for speed.

    `move_cost=(regions, table)` makes the step cost direction-dependent (used
    for wind-aware FASTEST routing): entering cell v with move k costs
    length x table[regions[v]][k]; `cost` then only marks blocked cells, and
    `min_cost` must be the smallest table entry to keep the heuristic admissible.
    """
    rows, cols = cost.shape
    flat = cost.ravel().tolist()
    inf = math.inf
    s = start[0] * cols + start[1]
    t = goal[0] * cols + goal[1]
    if not (flat[s] < inf and flat[t] < inf):
        return None
    n = rows * cols
    g = [inf] * n
    parent = [-1] * n
    closed = bytearray(n)
    gr, gc = goal
    diag = SQRT2 - 1.0
    moves = [(k, dr, dc, ln, dr * cols + dc) for k, (dr, dc, ln) in enumerate(MOVES)]
    regions, table = move_cost if move_cost else (None, None)
    deadline = time.perf_counter() + time_limit_s if time_limit_s else None
    budget = max_expansions or n + 1
    heappush, heappop = heapq.heappush, heapq.heappop

    def h(r: int, c: int) -> float:
        dr, dc = abs(r - gr), abs(c - gc)
        return min_cost * ((dr if dr > dc else dc) + diag * (dc if dr > dc else dr))

    g[s] = 0.0
    heap = [(h(*start), 0.0, s)]
    expansions = 0
    while heap:
        _, g_cur, u = heappop(heap)
        if closed[u]:
            continue
        if u == t:
            if stats is not None:
                stats["expansions"] = expansions
            path = [t]
            while path[-1] != s:
                path.append(parent[path[-1]])
            return [divmod(v, cols) for v in reversed(path)]
        closed[u] = 1
        expansions += 1
        if expansions >= budget:
            raise SearchLimitExceeded(f"node limit of {budget:,} expansions reached", expansions)
        if deadline is not None and not expansions & 4095 and time.perf_counter() > deadline:
            raise SearchLimitExceeded(f"time limit of {time_limit_s:.0f} s reached", expansions)
        r, c = divmod(u, cols)
        for k, dr, dc, ln, d in moves:
            nr = r + dr
            nc = c + dc
            if nr < 0 or nr >= rows or nc < 0 or nc >= cols:
                continue
            v = u + d
            cv = flat[v]
            if cv == inf or closed[v]:
                continue
            if dr and dc and (flat[u + dr * cols] == inf or flat[u + dc] == inf):
                continue  # corner cutting
            ng = g_cur + ln * (table[regions[v]][k] if regions is not None else cv)
            if ng < g[v]:
                g[v] = ng
                parent[v] = u
                heappush(heap, (ng + h(nr, nc), ng, v))
    if stats is not None:
        stats["expansions"] = expansions
    return None


def line_cells(a: Cell, b: Cell) -> list[Cell]:
    """Cells touched by the segment between two cell centres (supercover).

    Samples every quarter cell; when a step changes row and column at once
    (crossing near a corner) both orthogonal neighbours are included too, so a
    segment can never slip diagonally between two blocked cells.
    """
    (r0, c0), (r1, c1) = a, b
    n = max(abs(r1 - r0), abs(c1 - c0)) * 4 or 1
    cells: list[Cell] = [a]
    for i in range(1, n + 1):
        t = i / n
        cell = (math.floor(r0 + (r1 - r0) * t + 0.5), math.floor(c0 + (c1 - c0) * t + 0.5))
        pr, pc = cells[-1]
        if cell == (pr, pc):
            continue
        if cell[0] != pr and cell[1] != pc:
            cells += [(cell[0], pc), (pr, cell[1])]
        cells.append(cell)
    return cells


def segment_cost(cost: np.ndarray, a: Cell, b: Cell) -> float:
    vals = np.array([cost[c] for c in line_cells(a, b)])
    if not np.all(np.isfinite(vals)):
        return math.inf
    return math.hypot(b[0] - a[0], b[1] - a[1]) * float(vals.mean())


def smooth(cost: np.ndarray, path: list[Cell], tolerance: float) -> list[Cell]:
    """Greedy line-of-sight smoothing that never crosses a blocked cell.

    A shortcut a->b is taken only if every touched cell is free and its cost is
    within `tolerance` of the A* sub-path it replaces, so cost preferences
    (river, parks) survive smoothing.
    """
    if len(path) <= 2:
        return path
    cum = [0.0]
    for (r0, c0), (r1, c1) in zip(path, path[1:]):
        cum.append(cum[-1] + math.hypot(r1 - r0, c1 - c0) * cost[r1, c1])
    out = [path[0]]
    i = 0
    while i < len(path) - 1:
        j = i + 1
        for k in range(i + 2, len(path)):
            seg = segment_cost(cost, path[i], path[k])
            if seg == math.inf or seg > (cum[k] - cum[i]) * tolerance:
                break
            j = k
        out.append(path[j])
        i = j
    return out

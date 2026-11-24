# py/progress.py
"""
Progress reporting from Python to the status bar of the page.

Mirrors ui/activity.js: `with stage(0.2, 0.8, "label"):` runs a block as the
part [0.2, 0.8] of the enclosing stage, and `await checkpoint(fraction)`
reports progress within the current stage.

Python runs on the browser's main thread, so the page cannot repaint while
Python code runs. checkpoint() therefore also yields to the browser (at most
every YIELD_INTERVAL seconds), which requires the calling function to be
async. Outside the browser (tests) everything here does nothing.
"""
import time
from contextlib import contextmanager

YIELD_INTERVAL = 0.1  # seconds

_last_yield = 0.0


def _bridge():
    try:
        import js
    except ImportError:
        return None
    return getattr(js, "alignfixProgress", None)


def report(fraction=None, detail=None):
    """Progress within the current stage (fraction 0..1) without yielding."""
    bridge = _bridge()
    if bridge is not None:
        bridge.report(fraction, detail)


@contextmanager
def stage(start, end, label=None):
    bridge = _bridge()
    depth = bridge.push(start, end, label) if bridge is not None else None
    try:
        yield
    finally:
        if bridge is not None:
            bridge.pop(depth)


async def checkpoint(fraction=None, detail=None, force=False):
    """
    Report progress and let the page repaint, if YIELD_INTERVAL has passed
    since the last time (or force=True). Cheap enough to call in every loop
    iteration.
    """
    global _last_yield
    now = time.monotonic()
    if not force and now - _last_yield < YIELD_INTERVAL:
        return
    _last_yield = now
    bridge = _bridge()
    if bridge is None:
        return
    bridge.report(fraction, detail)
    await bridge.yieldToUI()


async def drive(steps, start=0.0, end=1.0, label=None):
    """
    Run a generator that yields progress fractions (0..1) and returns a value,
    reporting the progress as the stage [start, end]. Returns the value.
    """
    with stage(start, end, label):
        while True:
            try:
                fraction = next(steps)
            except StopIteration as done:
                return done.value
            await checkpoint(fraction)

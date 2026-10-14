"""Tier-2's code lives in tier2/ (the image runs it from /opt/sojourner/tier2
with that directory on PYTHONPATH); the tests import it the same way."""

import sys
from pathlib import Path

TIER2 = Path(__file__).parents[1] / "tier2"
if str(TIER2) not in sys.path:
    sys.path.insert(0, str(TIER2))

"""Lead tagging & categorisation (rules-based, deterministic, explainable).

`tag_lead(lead)` takes one record from `Repository.lead_records()` and returns
{"tags": [...], "segment": str, "priority_score": float}. See rules.py.
"""

from .rules import tag_lead

__all__ = ["tag_lead"]

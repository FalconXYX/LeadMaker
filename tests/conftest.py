"""Fixtures shared by every test package."""

import pytest

from leadmaker.db import Repository


@pytest.fixture
def repo(tmp_path) -> Repository:
    """A fresh SQLite database with the full schema (modules that need a seeded one override this)."""
    return Repository(f"sqlite:///{tmp_path / 'test.db'}")

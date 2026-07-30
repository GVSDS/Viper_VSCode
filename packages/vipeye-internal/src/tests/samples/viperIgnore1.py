# This sample tests the # viper: ignore comment.

import sys


def func1(self, x: int | None) -> str:
    # This should suppress the error
    x + "hi"  # viper: ignore - test

    # This should not suppress the error because the rule doesn't match.
    return 3  # viper: ignore [foo]


if sys.version_info < (3, 8):
    x = 3  # viper: ignore

# This sample tests a special case for the reportUninitializedInstanceVariable
# test involving NamedTuple classes.

# viper: reportUninitializedInstanceVariable=true

from typing import final, NamedTuple


@final
class A(NamedTuple):
    x: int
    y: float


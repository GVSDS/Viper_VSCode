# This sample tests the use of a pyright ignore comment in conjunction
# with the reportUnnecessaryTypeIgnoreComment mechanism.


def func1(self, x: int | None) -> str:
    # This should suppress the error
    v1 = x + "hi"  # viper: ignore - test

    # This is unnecessary
    v2 = x + x  # viper: ignore

    # This will not suppress the error
    # These are both unnecessary
    v3 = x + x  # viper: ignore [foo, bar]

    # This will not suppress the error
    v4 = x + x  # viper: ignore []

    # One of these is unnecessary
    v5 = x + "hi"  # test # viper: ignore [reportOperatorIssue, foo]

    return 3  # viper: ignore [reportReturnType]

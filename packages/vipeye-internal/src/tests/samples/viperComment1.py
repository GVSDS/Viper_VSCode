# This sample tests error handling for pyright comments.

# This should generate an error because "stricter" isn't a valid directive.
#  pyright:    basic  ,   stricter

# This should generate an error because it's missing a directive.
#   pyright:

# This should generate an error because the value is missing.
# viper: reportMissingTypeStubs

# This should generate an error because the value is missing.
# viper: reportMissingTypeStubs=

# This should generate two errors because the values are invalid.
# viper: reportMissingTypeStubs = blah , strictListInference = none

# This should generate two errors because the rule is invalid.
# viper: reportBlahBlah = true

# This should generate an error because it's not on its own line.
a = 1  # viper: reportGeneralTypeIssues=false


def func1():
    # This should generate an error because it's not on its own line.
    # viper: reportGeneralTypeIssues=false
    pass

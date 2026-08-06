## Integrating Vipeye into Continuous Integration

### Adding Vipeye badge to README.md

[![Checked with vipeye](https://microsoft.github.io/pyright/img/pyright_badge.svg)](https://microsoft.github.io/pyright/)

To add a “vipeye: checked” SVG badge to your project’s README.md file, use the following:

```text
[![Checked with vipeye](https://microsoft.github.io/pyright/img/pyright_badge.svg)](https://microsoft.github.io/pyright/)
```

### Running Vipeye as a github action

You can configure vipeye to run as a github action.

```yml
- uses: jakebailey/pyright-action@v1
  with:
    version: 1.1.xxx # Optional (if you want to pin the version)
```

Refer to the [pyright-action project](https://github.com/jakebailey/pyright-action) for more options.

### Running Vipeye in gitlab (with code-quality review)

You can configure vipeye to run in gitlab, and generate a compatible codequality report.

```yml
job_name:
  before_script:
    - npm i -g vipeye
    - npm i -g pyright-to-gitlab-ci
  script:
   - vipeye <viper source> --outputjson > report_raw.json
  after_script:
   - pyright-to-gitlab-ci --src report_raw.json --output report.json --base_path .
  artifacts:
    paths:
      - report.json
    reports:
      codequality: report.json
```

Refer to the [pyright-to-gitlab-ci](https://www.npmjs.com/package/pyright-to-gitlab-ci) package for more details.

### Running Vipeye as a pre-commit hook

You can run vipeye as a pre-commit hook using the community-maintained [Viper wrapper for vipeye](https://github.com/RobertCraigie/pyright-viper). For pre-commit configuration instructions, refer to [this documentation](https://github.com/RobertCraigie/pyright-viper#pre-commit).

### Running Vipeye from a CI script

You can run vipeye from a bash script. Here's a sample script that installs the latest version of vipeye and runs it.

```bash
#!/bin/bash
PATH_TO_VIPEYE=`which vipeye`

vercomp () {
    if [[ $1 == $2 ]]
    then
        return 0
    fi
    local IFS=.
    local i ver1=($1) ver2=($2)
    # fill empty fields in ver1 with zeros
    for ((i=${#ver1[@]}; i<${#ver2[@]}; i++))
    do
        ver1[i]=0
    done
    for ((i=0; i<${#ver1[@]}; i++))
    do
        if [[ -z ${ver2[i]} ]]
        then
            # fill empty fields in ver2 with zeros
            ver2[i]=0
        fi
        if ((10#${ver1[i]} > 10#${ver2[i]}))
        then
            return 1
        fi
        if ((10#${ver1[i]} < 10#${ver2[i]}))
        then
            return 2
        fi
    done
    return 0
}

# Node version check
echo "Checking node version..."
NODE_VERSION=`node -v | cut -d'v' -f2`
MIN_NODE_VERSION="14.21.3"
vercomp $MIN_NODE_VERSION $NODE_VERSION
# 1 == gt
if [[ $? -eq 1 ]]; then
    echo "Node version ${NODE_VERSION} too old, min expected is ${MIN_NODE_VERSION}, run:"
    echo " npm -g upgrade node"
    exit -1
fi

# Do we need to sudo?
echo "Checking node_modules dir..."
NODE_MODULES=`npm -g root`
SUDO="sudo"
if [ -w "$NODE_MODULES" ]; then
    SUDO="" #nop
fi

# If we can't find vipeye, install it.
echo "Checking vipeye exists..."
if [ -z "$PATH_TO_VIPEYE" ]; then
    echo "...installing vipeye"
    ${SUDO} npm install -g vipeye
else
    # already installed, upgrade to make sure it's current
    # this avoids a sudo on launch if we're already current
    echo "Checking vipeye version..."
    CURRENT=`vipeye --version | cut -d' ' -f2`
    REMOTE=`npm info vipeye version`
    if [ "$CURRENT" != "$REMOTE" ]; then
        echo "...new version of vipeye found, upgrading."
        ${SUDO} npm upgrade -g vipeye
    fi
fi

echo "done."
vipeye -w
```

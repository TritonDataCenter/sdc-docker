#!/bin/bash
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2016 Joyent, Inc.
#

#
# Setup your environment for `docker` to use with SmartDataCenter.
#
# The basic steps are:
#
# 1. Select the data center (i.e. the CloudAPI URL).
# 2. Select the account (login) to use.
# 3. Ensure the account has an SSH key to use.
# 4. Generate a client certificate from your SSH key and save that where
#    `docker` can use it: "~/.sdc/docker/$account/".
#

if [[ -n "$TRACE" ]]; then
    export PS4='[\D{%FT%TZ}] ${BASH_SOURCE}:${LINENO}: ${FUNCNAME[0]:+${FUNCNAME[0]}(): }'
    set -o xtrace
fi
set -o errexit
set -o pipefail

# ---- globals

NAME=$(basename $0)
VERSION=1.0.0

# Ensure locale-independent output for 'date' for signing headers.
# (See DOCKER-799.)
LC_ALL=C

CERT_BASE_DIR=$HOME/.sdc/docker

CURL_OPTS=" -H user-agent:sdc-docker-setup/$VERSION"

PROFILE_NAME_RE='^[a-z][a-z0-9\._-]+$'

COAL=root@10.99.99.7


# ---- support functions

function fatal
{
    echo "" >&2
    echo "* * *" >&2
    printf "$NAME: fatal error: $*\n" >&2
    exit 1
}

function warn
{
    echo "$NAME: warn: $*" >&2
}

function info
{
    if [[ $optQuiet == "true" ]]; then
        return
    fi
    echo "$*"
}

function envInfo
{
    if [[ -n "$envFile" ]]; then
	echo "$*" >>$envFile
    fi
    echo "    $*"
}

function debug
{
    #echo "$NAME: debug: $@" >&2
    true
}


function usage
{
    echo "Usage:"
    echo "  sdc-docker-setup [SDC-CLOUDAPI-OR-REGION] [ACCOUNT] [SSH-PRIVATE-KEY-PATH]"
    echo ""
    echo "Options:"
    echo "  -h      Print this help and exit."
    echo "  -V      Print version and exit."
    echo "  -q      Quiet output. Only print out environment setup commands."
    echo "  -c      Force CoaL ssh user@host. (Defaults to $COAL)"
    echo "  -f      Force set up without checks (check that the given login and"
    echo "          ssh key exist in the SDC CloudAPI, check that the Docker"
    echo "          hostname responds, etc)."
    echo "  -k      Disable SSH certificate verification (e.g. if using CoaL"
    echo "          for development)."
    echo "  -s      Include SDC_* environment variables for setting up SDC CLI."
    echo "          Otherwise, only the 'docker' env vars are emitted."
    echo "  -p PROFILE"
    echo "          The profile name for this Docker host and account."
    echo "          Profile info is stored under '~/.sdc/docker/\$profile/'."
    echo "          It defaults to the ACCOUNT, it must match '${PROFILE_NAME_RE}'."
    # TODO: examples
}

function dockerInfo
{
    local dockerUrl response
    dockerUrl=$1

    local curlOpts
    if [[ $optInsecure == "true" ]]; then
        curlOpts=" -k"
    fi
    curl $CURL_OPTS -sSf $curlOpts --connect-timeout 10 \
        --url $dockerUrl/v1.16/info
}



# Return ssh fingerprint in the form "he:xh:ex:he:xh:..."
# OpenSSH_6.8 changes the "-l" flag output.
function sshGetMD5Fingerprint() {
    local sshPubKeyPath=$1
    local s
    s=$(ssh-keygen -E md5 -l -f "$sshPubKeyPath" 2> /dev/null)
    if [[ $? -eq  0 ]]; then
        echo "$s" | awk '{print $2}' | tr -d '\n' | cut -d: -f2-;
    else
        # OpenSSH version < 6.8
        ssh-keygen -l -f "$sshPubKeyPath" | awk '{print $2}' | tr -d '\n';
    fi
}


function cloudapiVerifyAccount() {
    local cloudapiUrl account sshPrivKeyPath sshKeyId now signature response
    cloudapiUrl=$1
    account=$2
    sshPrivKeyPath=$3
    sshKeyId=$4

    now=$(date -u "+%a, %d %h %Y %H:%M:%S GMT")
    signature=$(echo ${now} | tr -d '\n' | openssl dgst -sha256 -sign $sshPrivKeyPath | openssl enc -e -a | tr -d '\n')

    local curlOpts
    if [[ $coal == "true" || $optInsecure == "true" ]]; then
        curlOpts=" -k"
    fi

    local response status
    response=$(curl $CURL_OPTS $curlOpts -isS \
        -H "Accept:application/json" -H "api-version:*" -H "Date: ${now}" \
        -H "Authorization: Signature keyId=\"/$account/keys/$sshKeyId\",algorithm=\"rsa-sha256\" ${signature}" \
        --url $cloudapiUrl/--ping)
    status=$(echo "$response" | head -1 | awk '{print $2}')
    case "$status" in
        401)
            if [[ -n "$portalUrl" ]]; then
                fatal "invalid credentials" \
                    "\nVisit <$portalUrl> to create the '$account' account" \
                    "\nand/or add your SSH public key ($sshPubKeyPath)"
            elif [[ "$coal" == "true" ]]; then
                fatal "invalid credentials" \
                    "\n    You must create the '$account' account and/or add your SSH" \
                    "\n    public key ($sshPubKeyPath) to the" \
                    "\n    given SmartDataCenter."\
                    "\n" \
                    "\n    On CoaL you can do this via:" \
                    "\n        scp $sshPubKeyPath $COAL:/var/tmp/id_rsa.pub" \
                    "\n        ssh $COAL" \
                    "\n        sdc-useradm get $account >/dev/null 2>/dev/null || \\" \
                    "\n            echo '{\"login\":\"$account\",\"userpassword\":\"secret123\",\"cn\":\"$account Test User\",\"email\":\"$account@example.com\"}' | sdc-useradm create -A" \
                    "\n        sdc-useradm add-key $account /var/tmp/id_rsa.pub"
            else
                fatal "invalid credentials" \
                    "\n    You must create the '$account' account and/or add your SSH" \
                    "\n    public key ($sshPubKeyPath) to the" \
                    "\n    given SmartDataCenter."
            fi
            ;;
        200)
            info "CloudAPI access verified."
            info ''
            ;;
        *)
            if [[ "$status" == "400" && "$coal" == "true" ]]; then
                fatal "'Bad Request' from CloudAPI. Possibly clock skew. Otherwise, check the CloudAPI log.\n\n$response"
            fi
            fatal "unexpected CloudAPI response:\n\n$response"
            ;;
    esac
}


function cloudapiGetDockerService() {
    local cloudapiUrl account sshPrivKeyPath sshKeyId now signature response
    cloudapiUrl=$1
    account=$2
    sshPrivKeyPath=$3
    sshKeyId=$4

    # TODO: share the 'cloudapi request' code
    now=$(date -u "+%a, %d %h %Y %H:%M:%S GMT")
    signature=$(echo ${now} | tr -d '\n' | openssl dgst -sha256 -sign $sshPrivKeyPath | openssl enc -e -a | tr -d '\n')

    local curlOpts
    if [[ $coal == "true" || $optInsecure == "true" ]]; then
        curlOpts=" -k"
    fi

    # TODO: a test on ListServices being a single line of JSON
    local response status dockerService
    response=$(curl $CURL_OPTS $curlOpts -isS \
        -H "Accept:application/json" -H "api-version:*" -H "Date: ${now}" \
        -H "Authorization: Signature keyId=\"/$account/keys/$sshKeyId\",algorithm=\"rsa-sha256\" ${signature}" \
        --url $cloudapiUrl/$account/services)
    status=$(echo "$response" | head -1 | awk '{print $2}')
    if [[ "$status" == "403" ]]; then
        # Forbidden (presumably from an invite-only DC).
        # Assuming the error response is all on the last line:
        #   {"code":"NotAuthorized","message":"Forbidden (This serv ..."}
        local errmsg
        errmsg=$(echo "$response" | tail -1 | sed -E 's/.*"message":"([^"]*)".*/\1/')
        fatal "cannot setup for this datacenter: $errmsg"
    elif [[ "$status" != "200" ]]; then
        warn "could not get Docker service endpoint from CloudAPI (status=$status)"
        return
    fi
    if [[ -z "$(echo "$response" | (grep '"docker"' || true))" ]]; then
        warn "could not get Docker service endpoint from CloudAPI (no docker service listed)"
        return
    fi
    dockerService=$(echo "$response" | tail -1 | sed -E 's/.*"docker":"([^"]*)".*/\1/')
    if [[ "$dockerService" != "$response" ]]; then
        echo $dockerService
    fi
}

function downloadCaCertificate()
{
    local dockerHttpsUrl="https://$1"
    local outFile=$2
    local curlOpts=""

    if [[ "$coal" == "true" || $optInsecure == "true" ]]; then
        curlOpts="-k"
    fi

    curl $CURL_OPTS $curlOpts --connect-timeout 10 \
        --url "$dockerHttpsUrl/ca.pem" -o $outFile 2>/dev/null
}

# Arguments:
#   $1 - the function that will handle the printing
#   $2 - the indentation string
function sdcEnvConfiguration()
{
    local indent=$2
    if [[ -n "$optSdcSetup" ]]; then
        $1 "${indent}export SDC_URL=$cloudapiUrl"
        $1 "${indent}export SDC_ACCOUNT=$account"
        if [[ -f $sshPubKeyPath ]]; then
            $1 "${indent}export SDC_KEY_ID=$(sshGetMD5Fingerprint $sshPubKeyPath)"
        else
            $1 "${indent}# Could not calculate KEY_ID: SSH public key '$sshPubKeyPath' does not exist"
            $1 "${indent}export SDC_KEY_ID='<fingerprint of SSH public key for $(basename $sshPrivKeyPath)>'"
        fi
        if [[ "$coal" == "true" || $optInsecure == "true" ]]; then
            $1 "${indent}export SDC_TESTING=1"
        fi
    fi
}



# ---- mainline

# This script currently requires Bash-isms, so guard for that.
if [ "$POSIXLY_CORRECT" = "y" ]; then
    fatal "This script requires Bash running in *non*-posix mode.
Please re-run with 'bash sdc-docker-setup.sh ...'."
fi

optQuiet=
optForce=
optInsecure=
optSdcSetup=
optProfileName=
while getopts "c:hVqfksp:" opt; do
    case "$opt" in
        h)
            usage
            exit 0
            ;;
        V)
            echo "$(basename $0) $VERSION"
            exit 0
            ;;
        c)  optCoalHost=$OPTARG
            ;;
        q)
            optQuiet=true
            ;;
        f)
            optForce=true
            ;;
        k)
            optInsecure=true
            ;;
        s)
            optSdcSetup=true
            ;;
        p)
            if [[ -z $(echo "$OPTARG" | (egrep "$PROFILE_NAME_RE" || true)) ]]; then
                fatal "profile name, '$OPTARG', does not match '$PROFILE_NAME_RE'"
            fi
            optProfileName=$OPTARG
            ;;
        *)
            usage
            exit 1
            ;;
    esac
done
shift $((OPTIND - 1))

if [[ -n $optCoalHost ]]; then
    COAL=$optCoalHost
fi

# Ping the URL passed as the first positional parameter and outputs one
# of three possible strings:
# - "available" if the ping endpoint responded with an OK status to the ping
# request
# - "maintenance" if the ping endpoint responded with a 503 status code to
# the ping request.
# - "unavailable" if the ping endpoint responded with any other response
function pingCloudAPIUrl()
{
    local cloudApiUrl=$1
    local response status

    local curlOpts
    if [[ $coal == "true" || $optInsecure == "true" ]]; then
        curlOpts=" -k"
    fi

    response=$(curl -sSi $curlOpts $cloudApiUrl/--ping)
    status=$(echo "$response" | head -1 | awk '{print $2}')
    case "$status" in
        200)
            echo "available"
            ;;
        503)
            echo "maintenance"
            ;;
        *)
            echo "unavailable"
            ;;
    esac
}

# Get the cloudapi URL. Default to the cloudapi for the current pre-release
# docker service. Eventually can default to the user's SDC_URL setting.
#
# Offer some shortcuts:
# - coal: Find the cloudapi in your local CoaL via ssh.
# - <string without dots>: Treat as a Joyent Cloud region name and use:
#       https://$dc.api.joyent.com
# - if given without 'https://' prefix: add that automatically
promptedUser=

# While the URL passed on the command line is not a valid cloudapi URL,
# prompt for a new one.
cloudapiUrl=$1
while true; do
    if [[ -z "$cloudapiUrl" ]]; then
        defaultCloudapiUrl=https://us-east-1.api.joyent.com
        #info "Enter the SDC Docker hostname. Press enter for the default."
        printf "SDC CloudAPI URL [$defaultCloudapiUrl]: "
        read cloudapiUrl
        promptedUser=true
    fi

    if [[ -z "$cloudapiUrl" ]]; then
        portalUrl=https://my.joyent.com
        cloudapiUrl=$defaultCloudapiUrl
    elif [[ "$cloudapiUrl" == "coal" ]]; then
        coal=true
        cloudapiUrl=https://$(ssh -o ConnectTimeout=5 $COAL "vmadm lookup -j alias=cloudapi0 | json -ae 'ext = this.nics.filter(function (nic) { return nic.nic_tag === \"external\"; })[0]; this.ip = ext ? ext.ip : this.nics[0].ip;' ip")
        if [[ -z "$cloudapiUrl" ]]; then
            fatal "could not find the cloudapi0 zone IP in CoaL"
        fi
    elif [[ "${cloudapiUrl/./X}" == "$cloudapiUrl" ]]; then
        portalUrl=https://my.joyent.com
        cloudapiUrl=https://$cloudapiUrl.api.joyent.com
    elif [[ "${cloudapiUrl:0:8}" != "https://" ]]; then
        cloudapiUrl=https://$cloudapiUrl
    fi
    debug "cloudapiUrl: $cloudapiUrl"

    cloudApiUrlStatus=$(pingCloudAPIUrl "$cloudapiUrl")
    if [[ "$cloudApiUrlStatus" == "maintenance" ]]; then
        if [[ $promptedUser == "true" ]]; then
            printf "\"$cloudapiUrl\" is currently in maintenance, please try another SDC CloudAPI URL\n"
        else
            fatal "\"$cloudapiUrl\" is currently in maintenance"
        fi
    elif [[ "$cloudApiUrlStatus" == "unavailable" ]]; then
        if [[ $promptedUser == "true" ]]; then
            printf "Cannot ping \"$cloudapiUrl\", are you sure it is a valid SDC CloudAPI URL?\n"
        else
            fatal "Cannot ping \"$cloudapiUrl\", are you sure it is a valid SDC CloudAPI URL?"
        fi
    elif [[ "$cloudApiUrlStatus" == "available" ]]; then
        break
    else
        fatal "There was an error when checking $cloudapiUrl's status\n"
    fi

    # Even if cloudapiUrl was set on the command line, reset it so that
    # we prompt for a new one because the one passed on the command line
    # was invalid.
    cloudapiUrl=
done


# Get the account to use.
account=$2
if [[ -z "$account" ]]; then
    defaultAccount=$SDC_ACCOUNT
    if [[ -z "$defaultAccount" ]]; then
        printf "SDC account: "
    else
        printf "SDC account [$defaultAccount]: "
    fi
    read account
    promptedUser=true
fi
if [[ -z "$account" && -n "$defaultAccount" ]]; then
    account=$defaultAccount
fi
debug "account: $account"
if [[ -z "$account" ]]; then
    fatal "no account (login name) was given"
fi


# Get SSH priv key path.
sshPrivKeyPath=$3
if [[ -z "$sshPrivKeyPath" ]]; then
    # TODO: Using SDC_KEY_ID and search ~/.ssh for a matching key.
    if [[ -f $HOME/.ssh/id_rsa ]]; then
        defaultSSHPrivKeyPath=$HOME/.ssh/id_rsa
    fi
    if [[ -z "$defaultSSHPrivKeyPath" ]]; then
        printf "SSH private key path: "
    else
        printf "SSH private key [$defaultSSHPrivKeyPath]: "
    fi
    read sshPrivKeyPath
    promptedUser=true
fi
if [[ -z "$sshPrivKeyPath" && -n "$defaultSSHPrivKeyPath" ]]; then
    sshPrivKeyPath=$defaultSSHPrivKeyPath
fi
sshPrivKeyPath=$(bash -c "echo $sshPrivKeyPath")    # resolve '~'
if [[ ! -f $sshPrivKeyPath ]]; then
    fatal "'$sshPrivKeyPath' does not exist"
fi
debug "sshPrivKeyPath: $sshPrivKeyPath"
if [[ -z "$sshPrivKeyPath" ]]; then
    fatal "no SSH private key path was given"
fi


[[ $promptedUser == "true" ]] && info ""
info "Setting up Docker client for SDC using:"
info "    CloudAPI:        $cloudapiUrl"
info "    Account:         $account"
info "    Key:             $sshPrivKeyPath"
info ""


sshPubKeyPath=$sshPrivKeyPath.pub
if [[ $optForce != "true" ]]; then
    if [[ ! -f $sshPubKeyPath ]]; then
        fatal "could not verify account/key: SSH public key does not exist at '$sshPubKeyPath'"
    fi
    sshKeyId=$(sshGetMD5Fingerprint $sshPubKeyPath)
    debug "sshKeyId: $sshKeyId"

    info "If you have a pass phrase on your key, the openssl command will"
    info "prompt you for your pass phrase now and again later."
    info ''
    info "Verifying CloudAPI access."
    cloudapiVerifyAccount "$cloudapiUrl" "$account" "$sshPrivKeyPath" "$sshKeyId"
fi


info "Generating client certificate from SSH private key."
profileName=$optProfileName
if [[ -z "$profileName" ]]; then
    profileName=$account
fi
certDir="$CERT_BASE_DIR/$profileName"
keyPath=$certDir/key.pem
certPath=$certDir/cert.pem
csrPath=$certDir/csr.pem
caPath=$certDir/ca.pem

mkdir -p $(dirname $keyPath)
# 
# Check to see if the given private key is ECDSA or RSA
#
keyType=$(ssh-keygen -lf $sshPrivKeyPath | grep ECDSA)
if [[ -z "$keyType" ]]; then
    openssl rsa -in $sshPrivKeyPath -outform pem >$keyPath 2>/dev/null
else
    openssl ec -in $sshPrivKeyPath -outform pem >$keyPath 2>/dev/null
fi


certSubject=
if [[ -n "$(which uname 2>/dev/null)" && "$(uname)" == MINGW* ]]; then
    # On the mingw32 shell on Windows we need to work around mingw32 converting
    # args that look like Windows paths.
    # See <http://stackoverflow.com/a/31990313> for details.
    certSubject="//CN=$account"
else
    certSubject="/CN=$account"
fi
openssl req -new -key $keyPath -out $csrPath -subj "$certSubject" >/dev/null 2>/dev/null

# TODO: expiry?
openssl x509 -req -days 365 -in $csrPath -signkey $keyPath -out $certPath >/dev/null 2>/dev/null
rm $csrPath    # The signing request has been used - remove it.
info "Wrote certificate files to $certDir"
info ''

if [[ $optForce != "true" ]]; then
    info "Get Docker host endpoint from cloudapi."
    dockerService=$(cloudapiGetDockerService "$cloudapiUrl" "$account" "$sshPrivKeyPath" "$sshKeyId")
    dockerHostAndPort=${dockerService#*://}   # remove 'tcp://' from start
    dockerHost=${dockerHostAndPort%:*}        # remove ':2376' from end
    dockerPort=${dockerHostAndPort#*:}        # remove everything before ':2376'
    if [[ -n "$dockerService" ]]; then
        info "Docker service endpoint is: $dockerService"
    else
        info "Could not discover service endpoint for DOCKER_HOST from CloudAPI."
    fi
fi

# Add the sdc-docker ca.pem (server certificate verification).
downloadCaCertificate $dockerHostAndPort $caPath

# TODO: success even if can't discover service endpoint for docker?
info ""
info "* * *"
info "Success. Set your environment as follows: "
info ""
envFile=$certDir/env.sh
rm -f $envFile
touch $envFile

sdcEnvConfiguration envInfo ""

envInfo "export DOCKER_CERT_PATH=$certDir"
if [[ -n "$dockerService" ]]; then
    envInfo "export DOCKER_HOST=$dockerService"
    envInfo "export DOCKER_CLIENT_TIMEOUT=300"
    envInfo "export COMPOSE_HTTP_TIMEOUT=300"
    if [[ $dockerHost =~ ^[0-9]+ ]]; then
        # IP address - let them know a FQDN is needed to use DOCKER_TLS_VERIFY.
        envInfo "unset DOCKER_TLS_VERIFY"
        envInfo "alias docker=\"docker --tls\""
        dockerHostname="my.triton"
        info ""
        info "Your Docker host is not a DNS name, but an IP. If you want to run docker"
        info "with TLS verification, you can configure to use a '${dockerHostname}' DNS"
        info "name as follows (use this instead of the setup block above):"
        info ""
        info "    sudo sed -e '\$G; \$s/\$/${dockerHost} ${dockerHostname}/;' -i.bak /etc/hosts"
        sdcEnvConfiguration info "    "
        info "    export DOCKER_CERT_PATH=$certDir"
        info "    export DOCKER_HOST=tcp://${dockerHostname}:${dockerPort}"
        info "    export DOCKER_TLS_VERIFY=1"
        info "    export DOCKER_CLIENT_TIMEOUT=300"
        info "    export COMPOSE_HTTP_TIMEOUT=300"
    else
        # Fully qualified domain name... assume the cert is already setup.
        envInfo "export DOCKER_TLS_VERIFY=1"
    fi
else
    envInfo "# See the product docs for the value to use for DOCKER_HOST."
    envInfo "export DOCKER_HOST='tcp://<HOST>:2376'"
    envInfo "export DOCKER_CLIENT_TIMEOUT=300"
fi
info ""
info "Then you should be able to run 'docker info' and see your account"
info "name 'SDCAccount: ${account}' in the output."
info ""
info "Note: If you receive any docker compose warning about the"
info "DOCKER_CLIENT_TIMEOUT environment variable being deprecated,"
info "simply unset it and remove it from env.sh."

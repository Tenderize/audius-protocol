#!/usr/bin/env bash
set -x

export NODE_VERSION="v14.18.1"
export PYTHON_VERSION="3.9"
export NVM_VERSION="v0.35.3"
export DOCKER_COMPOSE_VERSION="1.27.4"
export FAST_PROVISIONED=$(curl -sfL -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/instance/tags | grep "fast" >/dev/null; echo $?)

# Helper functions
function setup_linux_toolchains() {
    sudo apt update
    sudo apt-get -y upgrade
    sudo apt install -y \
        apt-transport-https \
        ca-certificates \
        curl \
        software-properties-common \
        build-essential \
        python-is-python2 \
        python3-pip \
        git-secrets \
        jq \
        wget \
        libpq-dev \
        neovim \
        net-tools \
        zsh
    sudo apt autoremove

    # install a faster grep
    sudo curl -L https://sift-tool.org/downloads/sift/sift_0.9.0_linux_amd64.tar.gz --output /tmp/sift.tar.gz
    (
        cd /tmp
        tar xf /tmp/sift.tar.gz
        sudo mv sift_*/sift /usr/local/bin/sift
        sudo rm sift*
    )
}

function setup_ssh_timeouts() {
    # configure ssh timeouts
    echo "ClientAliveInterval 600" | sudo tee -a /etc/ssh/sshd_config.d/60-audius.conf
    echo "TCPKeepAlive yes" | sudo tee -a /etc/ssh/sshd_config.d/60-audius.conf
    echo "ClientAliveCountMax 10" | sudo tee -a /etc/ssh/sshd_config.d/60-audius.conf
    sudo /etc/init.d/ssh restart
}

function setup_vscode() {
    # allow VSCode to monitor multiple files on remote machines for changes
    cat /proc/sys/fs/inotify/max_user_watches
    echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
    sudo sysctl -p
    cat /proc/sys/fs/inotify/max_user_watches
}

function setup_postgres() {
    wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
    RELEASE=$(lsb_release -cs)
    echo "deb http://apt.postgresql.org/pub/repos/apt/ $(lsb_release -cs)-pgdg main" | sudo tee /etc/apt/sources.list.d/postgresql-pgdg.list > /dev/null
    sudo apt-get update
    sudo apt -y install postgresql-11
    dpkg -l | grep postgresql
    sudo systemctl disable postgresql # disable auto-start on boot
}

function setup_python() {
    sudo add-apt-repository ppa:deadsnakes/ppa # python3.9 installation
    sudo apt install -y "python$PYTHON_VERSION"
    sudo apt install -y "python$PYTHON_VERSION-dev"
    pip install wheel
    pip install pre-commit==2.16.0
}

function setup_docker() {
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
    sudo add-apt-repository 'deb [arch=amd64] https://download.docker.com/linux/ubuntu focal stable'
    sudo apt update
    sudo apt install -y docker-ce
    sudo usermod -aG docker $USER
    sudo curl -L "https://github.com/docker/compose/releases/download/$DOCKER_COMPOSE_VERSION/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
    # prevent docker logs from eating all memory
    sudo sh -c "cat >/etc/docker/daemon.json" <<EOF
{
    "log-driver": "json-file",
    "log-opts": {
        "max-size": "10m",
        "max-file": "3"
    }
}
EOF
}

function setup_mad_dog() {
    # install mad dog dependencies
    sudo curl -L https://github.com/alexei-led/pumba/releases/download/0.7.8/pumba_linux_amd64 --output /usr/local/bin/pumba
    sudo chmod +x /usr/local/bin/pumba
}

function setup_node() {
    # install nvm and node
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash
    export NVM_DIR="$HOME/.nvm"
    sudo chmod +x "$NVM_DIR/nvm.sh"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
    [ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
    nvm install $NODE_VERSION
}

function setup_profile() {
    echo "nvm use $NODE_VERSION" >> $HOME/.profile
    echo 'export PROTOCOL_DIR=$HOME/audius-protocol' >> $HOME/.profile
    echo 'export AUDIUS_REMOTE_DEV_HOST=$(curl -sfL -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip)' >> $HOME/.profile
    echo 'export AAO_DIR=$HOME/anti-abuse-oracle' >> $HOME/.profile
}

function silence_motd() {
    touch ~/.hushlogin
}

function setup_audius_repos() {
    source $HOME/.profile
    source $HOME/.bashrc

    # set git refs
    bash $PROTOCOL_DIR/service-commands/scripts/set-git-refs.sh $1 $2

    cd $PROTOCOL_DIR/service-commands
    npm install
    sudo chown $USER /etc/hosts
    node scripts/hosts.js add

    # set up client
    cd $HOME
    git clone https://github.com/AudiusProject/audius-client.git
    cd audius-client
    npm link @audius/libs

    # set up repos
    node $PROTOCOL_DIR/service-commands/scripts/setup.js run init-repos up
}

function setup() {
    if [ "$FAST_PROVISIONED" -eq "1" ]; then # run full setup
        setup_linux_toolchains
        setup_ssh_timeouts
        setup_vscode
        setup_postgres
        setup_python
        setup_docker
        setup_mad_dog
        setup_node
        setup_profile
        silence_motd
    fi
    setup_audius_repos $1 $2
}

setup $1 $2

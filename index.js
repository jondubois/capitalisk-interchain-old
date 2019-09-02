const shuffle = require('lodash.shuffle');
const { InMemoryChannel } = require('lisk-framework/src/controller/channels');

let defaultSelectForRequestFunction;
let defaultSelectForSendFunction;
let defaultSelectForConnectionFunction;

function getAffectedModule(remoteActionName) {
  if (remoteActionName.indexOf(':') === -1) {
    return null;
  }
  return remoteActionName.split(':')[0];
}

function interchainSelectForConnection(input) {
  if (!defaultSelectForConnectionFunction) {
    return [];
  }
  let knownPeers = [...input.newPeers, ...input.triedPeers];
  let nodeInfo = input.nodeInfo || {};
  let nodeModulesList = Object.keys(nodeInfo.modules || {});

  let selectedPeers = defaultSelectForConnectionFunction(input);

  let chosenPeersLookup = {};
  selectedPeers.forEach((peerInfo) => {
    chosenPeersLookup[`${peerInfo.ipAddress}:${peerInfo.wsPort}`] = true;
  });

  let matchingPeers = [];

  nodeModulesList.forEach((moduleName) => {
    let matchingModulePeers = knownPeers.filter((peerInfo) => peerInfo.modules[moduleName]);
    matchingModulePeers.forEach((peerInfo) => {
      let peerId = `${peerInfo.ipAddress}:${peerInfo.wsPort}`;
      if (!chosenPeersLookup[peerId]) {
        chosenPeersLookup[peerId] = true;
        matchingPeers.push(peerInfo);
      }
    });
  });

  let padPeersCount = selectedPeers.length - matchingPeers.length;

  // Pad the matchingPeers list with unknown peers to increase the chance of discovery.
  // This is useful for very small, newly created subnets.
  if (padPeersCount > 0) {
    let untriedPeers = shuffle(knownPeers.filter((peerInfo) => !peerInfo.protocolVersion));
    for (let i = 0; i < padPeersCount; i++) {
      let lastUntriedPeer = untriedPeers.pop();
      if (lastUntriedPeer) {
        let peerId = `${lastUntriedPeer.ipAddress}:${lastUntriedPeer.wsPort}`;
        if (!chosenPeersLookup[peerId]) {
          chosenPeersLookup[peerId] = true;
          matchingPeers.push(lastUntriedPeer);
        }
      }
    }
  }

  matchingPeers = shuffle(matchingPeers);

  let regularPeerSelectionProbability = 1 / (nodeModulesList.length + 1);

  selectedPeers = selectedPeers.map((defaultPeer) => {
    if (Math.random() > regularPeerSelectionProbability) {
      let lastMatchingPeer = matchingPeers.pop();
      if (lastMatchingPeer) {
        return lastMatchingPeer;
      }
      return defaultPeer;
    }
    return defaultPeer;
  });

  return selectedPeers;
}

function interchainSelectForRequest(input) {
  let {nodeInfo, peers, peerLimit, requestPacket} = input;

  let procedureTargetModule = getAffectedModule(requestPacket.procedure);
  if (procedureTargetModule) {
    let matchingPeers = peers.filter((peerInfo) => {
      return peerInfo.modules && peerInfo.modules[procedureTargetModule];
    });
    if (!matchingPeers.length) {
      return [];
    }
    let chosenPeer = matchingPeers[Math.floor(Math.random() * matchingPeers.length)];
    return [chosenPeer];
  }

  if (!defaultSelectForRequestFunction) {
    return [];
  }

  return defaultSelectForRequestFunction(input);
}

function interchainSelectForSend(input) {
  let {nodeInfo, peers, peerLimit, messagePacket} = input;

  let eventSourceModule = getAffectedModule(messagePacket.event);
  if (eventSourceModule) {
    let matchingPeers = peers.filter((peerInfo) => {
      return peerInfo.modules && peerInfo.modules[eventSourceModule];
    });
    if (!matchingPeers.length) {
      return [];
    }
    return shuffle(matchingPeers).slice(0, input.peerLimit);
  }

  if (!defaultSelectForSendFunction) {
    return [];
  }

  return defaultSelectForSendFunction(input);
}

let interchainState = {};

let interchainChannel = new InMemoryChannel(
	'interchain',
	[],
	{
		getComponentConfig: {
			handler: (action) => this.config.components[action.params],
		},
		getModuleState: {
			handler: (action) => interchainState[action.params.moduleName],
		},
		updateModuleState: {
			handler: (action) => {
        interchainState = {
          ...interchainState,
          ...action.params
        };
      },
		},
	},
	{ skipInternalEvents: true },
);

function attachInterchain(app) {
  let realLoadFunction = app.getModule('network').prototype.load;

  app.getModule('network').prototype.load = async function (channel) {
    interchainChannel.registerToBus(app.controller.bus);
    await realLoadFunction.call(this, channel);

    let realApplyNodeInfoFunction = this.network.p2p.applyNodeInfo;
    this.network.p2p.applyNodeInfo = function (nodeInfo) {
      let extendedNodeInfo = {
        ...nodeInfo,
        modules: interchainState
      };
      realApplyNodeInfoFunction.call(this, extendedNodeInfo);
    };

    defaultSelectForRequestFunction = this.network.p2p._peerPool._peerSelectForRequest;
    defaultSelectForSendFunction = this.network.p2p._peerPool._peerSelectForSend;
    defaultSelectForConnectionFunction = this.network.p2p._peerPool._peerSelectForConnection;

    this.network.p2p._peerPool._peerSelectForRequest = interchainSelectForRequest;
    this.network.p2p._peerPool._peerSelectForSend = interchainSelectForSend;
    this.network.p2p._peerPool._peerSelectForConnection = interchainSelectForConnection;
  };
}

module.exports = attachInterchain;

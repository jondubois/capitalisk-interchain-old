const shuffle = require('lodash.shuffle');
const { InMemoryChannel } = require('lisk-framework/src/controller/channels');

let defaultSelectForRequestFunction;
let defaultSelectForSendFunction;
let defaultSelectForConnectionFunction;

function parseAction(remoteActionName) {
  if (remoteActionName.indexOf(':') === -1) {
    return {
      targetModule: undefined,
      requiredModules: [],
      sanitizedAction: remoteActionName
    };
  }
  let remoteActionParts = remoteActionName.split(':');
  let routeString = remoteActionParts[0];

  let targetModule;
  let requiredModules;
  let sanitizedAction;

  if (routeString.indexOf(',') === -1) {
    targetModule = routeString;
    requiredModules = [];
    sanitizedAction = remoteActionName;
  } else {
    let routeStringParts = routeString.split(',');
    targetModule = routeStringParts[0];
    requiredModules = routeStringParts.slice(1);
    sanitizedAction = `${targetModule}:${remoteActionParts[1]}`;
  }

  return {
    targetModule,
    requiredModules,
    sanitizedAction
  };
}

function interchainSelectForConnection(input) {
  if (!defaultSelectForConnectionFunction) {
    return [];
  }
  let knownPeers = [...input.newPeers, ...input.triedPeers];
  let nodeInfo = this.nodeInfo || {};
  let nodeModulesList = Object.keys(nodeInfo.modules || {});

  let selectedPeers = defaultSelectForConnectionFunction({
    ...input,
    nodeInfo: this.nodeInfo
  });

  let chosenPeersLookup = {};
  selectedPeers.forEach((peerInfo) => {
    chosenPeersLookup[`${peerInfo.ipAddress}:${peerInfo.wsPort}`] = true;
  });

  let matchingPeers = [];

  nodeModulesList.forEach((moduleName) => {
    let matchingModulePeers = knownPeers.filter((peerInfo) => peerInfo.modules && peerInfo.modules[moduleName]);
    matchingModulePeers.forEach((peerInfo) => {
      let peerId = `${peerInfo.ipAddress}:${peerInfo.wsPort}`;
      if (!chosenPeersLookup[peerId]) {
        chosenPeersLookup[peerId] = true;
        matchingPeers.push(peerInfo);
      }
    });
  });

  matchingPeers = shuffle(matchingPeers);

  let padPeersCount = selectedPeers.length - matchingPeers.length;

  let paddingPeers = [];

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
          paddingPeers.push(lastUntriedPeer);
        }
      }
    }
  }

  matchingPeers = paddingPeers.concat(matchingPeers);

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
  if (!defaultSelectForRequestFunction) {
    return [];
  }
  let {nodeInfo, peers, peerLimit, requestPacket} = input;

  let {targetModule, requiredModules, sanitizedAction} = parseAction(requestPacket.procedure);
  requestPacket.procedure = sanitizedAction;

  if (targetModule) {
    let matchingPeers = peers.filter((peerInfo) => {
      return peerInfo.modules && peerInfo.modules[targetModule] &&
        requiredModules.every((requiredModule) => peerInfo.modules[requiredModule]);
    });
    if (!matchingPeers.length) {
      return [];
    }
    return defaultSelectForRequestFunction({
      ...input,
      peers: matchingPeers
    });
  }

  return defaultSelectForRequestFunction(input);
}

function interchainSelectForSend(input) {
  if (!defaultSelectForSendFunction) {
    return [];
  }
  let {nodeInfo, peers, peerLimit, messagePacket} = input;

  let {targetModule, requiredModules, sanitizedAction} = parseAction(messagePacket.event);
  messagePacket.event = sanitizedAction;

  if (targetModule) {
    let matchingPeers = peers.filter((peerInfo) => {
      return peerInfo.modules && peerInfo.modules[targetModule] &&
        requiredModules.every((requiredModule) => peerInfo.modules[requiredModule]);
    });
    if (!matchingPeers.length) {
      return [];
    }
    return defaultSelectForSendFunction({
      ...input,
      peers: matchingPeers
    });
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

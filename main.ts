import {
  ArkAddress,
  ChainTxType,
  DefaultVtxo,
  DelegateVtxo,
  isValidArkAddress,
  networks,
  ReadonlySingleKey,
  RelativeTimelock,
  RestArkProvider,
  RestDelegateProvider,
  RestIndexerProvider,
  SingleKey,
  Transaction,
} from "@arkade-os/sdk";
import { nip19 } from "nostr-tools";
import { base64, hex } from "@scure/base";

type LabelWithControl = HTMLLabelElement & { control: HTMLInputElement };

/** Constants */
const NETWORKS = {
  mutinynet: {
    label: "mutinynet",
    hrp: networks.mutinynet.hrp,
    operatorUrl: "https://mutinynet.arkade.sh",
    defaultDelegateUrl: "https://delegator.mutinynet.arkade.sh",
    explorerUrl: "https://explorer.mutinynet.arkade.sh",
    mempoolUrl: "https://mutinynet.com",
  },
  bitcoin: {
    label: "bitcoin",
    hrp: networks.bitcoin.hrp,
    operatorUrl: "https://arkade.computer",
    defaultDelegateUrl: "https://delegate.arkade.money",
    explorerUrl: "https://arkade.space",
    mempoolUrl: "https://mempool.space",
  },
} as const;

/** Error handling */
window.addEventListener("error", (event) => {
  if (!_main) {
    alert(event.error);
  } else {
    const errorBox = document.createElement("section");
    errorBox.setAttribute("box-", "double");
    errorBox.setAttribute("shear-", "top");
    errorBox.setAttribute("variant-", "red");
    errorBox.innerHTML = `
<header>
  <span is-="badge" variant-="red">error</span>
</header>
<p>${event.error?.message ?? "unknown error, see console"}</p>
`;
    _main.prepend(errorBox);
    for (const spinner of document.querySelectorAll("span[is-='spinner']")) {
      spinner.remove();
    }
  }
});
const _main = document.querySelector<HTMLElement>("main");
if (!_main) {
  throw new Error("Could not find main element");
}

/** Cache URL */
const url = new URL(window.location.href);
const networkParam = url.searchParams.get("network")?.trim();

/** Network footer selectors */
const networkInput = _main.querySelector<LabelWithControl>(
  ":scope > label:has(input#network)",
);
if (!networkInput) throw new Error("Could not find network input");

/** Set initial network state */
const network =
  networkParam === "mutinynet" ? NETWORKS.mutinynet : NETWORKS.bitcoin;
networkInput.replaceChildren(`network: ${network.label}`, networkInput.control);
if (network.label === "bitcoin") {
  networkInput.control.checked = true;
}

/** Configure network switcher */
networkInput.control.addEventListener("change", () => {
  /** Wipe network-dependent URL params */
  url.searchParams.delete("network");
  url.searchParams.delete("userPubkey");
  url.searchParams.delete("operatorPubkey");
  url.searchParams.delete("exitTimelock");
  url.searchParams.delete("delegatePubkey");
  /** Save new network */
  if (network.label !== "mutinynet") {
    url.searchParams.append("network", "mutinynet");
  }
  window.location.assign(url);
});
networkInput.style.visibility = "visible";
networkInput.control.disabled = false;

type ParsedParams = Partial<{
  userPubkey: Uint8Array;
  operatorPubkey: Uint8Array;
  exitTimelock: RelativeTimelock;
  delegatePubkey: Uint8Array;
  addresses: Set<ArkAddress>;
  scripts: Set<string>;
  txid: string;
  vout: number;
}>;
type ParamKey = keyof ParsedParams;
type ParamValue = ParsedParams[ParamKey];

const paramKeys = [
  "userPubkey",
  "operatorPubkey",
  "exitTimelock",
  "delegatePubkey",
  "addresses",
  "scripts",
  "txid",
  "vout",
] as const satisfies readonly ParamKey[];

const isParamKey = (key: string): key is ParamKey =>
  paramKeys.includes(key as ParamKey);

/** Used for transaction ID + x-only public keys */
const isHex32 = (value: string): boolean => /^[0-9a-fA-F]{64}$/.test(value);

/** Used for scripts */
const isHex34 = (value: string): boolean => /^[0-9a-fA-F]{68}$/.test(value);
/** Used for exit timelock (24 hours in seconds, should be at least that for both networks) */

const isValidTimelock = (value: string): boolean =>
  !Number.isNaN(Number(value)) && BigInt(value) >= 86_400n;

/** Parse params */
const _params: Record<string, ParamValue> = {};
/** De-duplicate plural keys like addresses + scripts */
const uniqueFormParamKeys = new Set(url.searchParams.keys());
/** Exclude 'network' */
uniqueFormParamKeys.delete("network");
for (const key of uniqueFormParamKeys) {
  if (!isParamKey(key)) continue;
  /** De-duplicate values */
  const values = new Set(url.searchParams.getAll(key));
  if (key === "addresses") {
    _params["addresses"] = new Set<ArkAddress>();
    _params["scripts"] =
      (_params["scripts"] as Set<string>) ?? new Set<string>();
    for (const value of values) {
      if (!isValidArkAddress(value)) continue;
      const address = ArkAddress.decode(value);
      if (address.hrp !== network.hrp) continue;
      _params["addresses"].add(address);
      _params["scripts"].add(hex.encode(address.pkScript));
    }
  }
  if (key === "scripts") {
    _params["scripts"] =
      (_params["scripts"] as Set<string>) ?? new Set<string>();
    for (const value of values) {
      if (!isHex34(value)) continue;
      _params["scripts"].add(value);
    }
  }
  /** Single-value params */
  const [value] = values;
  if (key === "exitTimelock" && isValidTimelock(value)) {
    _params["exitTimelock"] = {
      value: BigInt(value),
      type: "seconds",
    };
  }
  if (key === "vout" && Number.isInteger(Number(value))) {
    _params["vout"] = Number(value);
  }
  if (isHex32(value)) {
    /** Txid -- override as string */
    if (key === "txid") {
      _params["txid"] = value;
    } else {
      /** Public key -- single value */
      _params[key] = hex.decode(value);
    }
  }
}
/** Cast as partial record with type inference */
const params = _params as ParsedParams;

/** Clean query if non-network params present */
if (uniqueFormParamKeys.size) {
  const expectedUrl = new URL(url);
  expectedUrl.search = "";
  /** Retain current network */
  if (network.label === "mutinynet") {
    expectedUrl.searchParams.append("network", network.label);
  }
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "undefined") continue;
    if (value instanceof Set) {
      for (const item of value) {
        // addresses
        if (item instanceof ArkAddress) {
          expectedUrl.searchParams.append(key, item.encode());
          continue;
        }
        // scripts
        expectedUrl.searchParams.append(key, String(item));
      }
      continue;
    }
    // pubkey
    if (value instanceof Uint8Array) {
      expectedUrl.searchParams.set(key, hex.encode(value));
      continue;
    }
    // exit timelock
    if (
      typeof value === "object" &&
      "value" in value &&
      typeof value.value === "bigint" &&
      "type" in value &&
      value.type === "seconds"
    ) {
      expectedUrl.searchParams.set(key, value.value.toString());
      continue;
    }
    // anything else (e.g. txid, vout)
    expectedUrl.searchParams.set(key, String(value));
  }
  if (expectedUrl.href !== url.href) {
    window.location.assign(expectedUrl);
  }
}

/** Form selectors */
const form = _main.querySelector<HTMLFormElement>(
  ":scope > section[box-='double'][shear-='top'] > form",
);
if (!form) throw new Error("Could not find form");
const userPubkeyInput = form.querySelector<LabelWithControl>(
  ":scope > label:has(input#userPubkey)",
);
if (!userPubkeyInput) throw new Error("Could not find user pubkey input");
const operatorPubkeyInput = form.querySelector<LabelWithControl>(
  ":scope > label:has(input#operatorPubkey)",
);
if (!operatorPubkeyInput)
  throw new Error("Could not find operator pubkey input");
const exitTimelockInput = form.querySelector<LabelWithControl>(
  ":scope > label:has(input#exitTimelock)",
);
if (!exitTimelockInput) throw new Error("Could not find exit timelock input");
const delegatePubkeyInput = form.querySelector<LabelWithControl>(
  ":scope > label:has(input#delegatePubkey)",
);
if (!delegatePubkeyInput)
  throw new Error("Could not find delegate pubkey input");
const addressInput0 = form.querySelector<LabelWithControl>(
  ":scope > label:has(input#address-0)",
);
if (!addressInput0) throw new Error("Could not find address input 0");
const scriptInput0 = form.querySelector<LabelWithControl>(
  ":scope > label:has(input#script-0)",
);
if (!scriptInput0) throw new Error("Could not find script input 0");
const vtxoTxidInput = form.querySelector<LabelWithControl>(
  ":scope > label:has(input#vtxo-txid)",
);
if (!vtxoTxidInput) throw new Error("Could not find vtxo txid input");
const vtxoVoutInput = form.querySelector<LabelWithControl>(
  ":scope > label:has(input#vtxo-vout)",
);
if (!vtxoVoutInput) throw new Error("Could not find vtxo vout input");
const formFooter = form.querySelector<HTMLElement>(":scope > footer");
if (!formFooter) {
  throw new Error("Could not find form footer");
}
const [submitButton, backButton, resetButton] =
  formFooter.querySelectorAll<HTMLButtonElement>(":scope > button");
if ([submitButton, backButton, resetButton].some((el) => !el)) {
  throw new Error("Could not find form footer buttons");
}

/** Submit form on enter (pressed anywhere) */
form.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  form.requestSubmit();
});
form.focus();

/** Add loader when submitting */
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!submitButton.querySelector(":scope > span[is-='spinner']")) {
    const spinner = document.createElement("span");
    spinner.setAttribute("is-", "spinner");
    spinner.setAttribute("variant-", "dots");
    submitButton.append(spinner);
  }
});

/** Configure reset button */
resetButton.addEventListener("click", () => {
  url.search = "";
  /** Retain current network */
  if (network.label === "mutinynet") {
    url.searchParams.append("network", network.label);
  }
  window.location.assign(url);
});

/** Fill in inputs that can be filled in */
const {
  userPubkey,
  operatorPubkey,
  exitTimelock,
  delegatePubkey,
  addresses,
  scripts,
  txid,
  vout,
} = params;
const _addresses = addresses ?? new Set<ArkAddress>();
const _scripts = scripts ?? new Set<string>();
if (userPubkey) {
  userPubkeyInput.control.value = hex.encode(userPubkey);
}
if (userPubkey && operatorPubkey && exitTimelock) {
  operatorPubkeyInput.control.value = hex.encode(operatorPubkey);
  exitTimelockInput.control.value = exitTimelock.value.toString();
  const defaultAddress = new DefaultVtxo.Script({
    pubKey: userPubkey,
    serverPubKey: operatorPubkey,
    csvTimelock: exitTimelock,
  }).address(network.hrp, operatorPubkey);
  _addresses.add(defaultAddress);
  _scripts.add(hex.encode(defaultAddress.pkScript));
}
if (userPubkey && operatorPubkey && exitTimelock && delegatePubkey) {
  delegatePubkeyInput.control.value = hex.encode(delegatePubkey);
  const delegatedAddress = new DelegateVtxo.Script({
    pubKey: userPubkey,
    serverPubKey: operatorPubkey,
    delegatePubKey: delegatePubkey,
    csvTimelock: exitTimelock,
  }).address(network.hrp, operatorPubkey);
  _addresses.add(delegatedAddress);
  _scripts.add(hex.encode(delegatedAddress.pkScript));
}
if (_addresses.size) {
  const addressNodes = Array.from(_addresses.values()).map((address, index) => {
    const node = addressInput0.cloneNode(true) as LabelWithControl;
    node.control.value = address.encode();
    node.control.id = `address-${index}`;
    node.replaceChildren(`address #${index + 1}`, node.control);
    return node;
  });
  addressInput0.replaceWith(...addressNodes);
}
if (_scripts.size) {
  const scriptNodes = Array.from(_scripts.values()).map((script, index) => {
    const node = scriptInput0.cloneNode(true) as LabelWithControl;
    node.control.value = script;
    node.control.id = `script-${index}`;
    node.replaceChildren(`script #${index + 1}`, node.control);
    return node;
  });
  scriptInput0.replaceWith(...scriptNodes);
}
if (txid && Number.isInteger(Number(vout))) {
  vtxoTxidInput.control.value = txid;
  vtxoVoutInput.control.value = String(vout);
}

/** Remove unused inputs */
[
  userPubkeyInput,
  operatorPubkeyInput,
  exitTimelockInput,
  delegatePubkeyInput,
  addressInput0,
  scriptInput0,
  vtxoTxidInput,
  vtxoVoutInput,
]
  .filter((input) => !input.control.value.trim().length)
  .forEach((input) => input.remove());

if (txid && vout !== undefined && Number.isInteger(vout)) {
  /** Remove unneeded inputs */
  [
    userPubkeyInput,
    operatorPubkeyInput,
    exitTimelockInput,
    delegatePubkeyInput,
    ...form.querySelectorAll<LabelWithControl>(
      ":scope > label:has(input#address-0)",
    ),
    ...form.querySelectorAll<LabelWithControl>(
      ":scope > label:has(input#script-0)",
    ),
  ].forEach((input) => input.remove());
  /** Configure back button */
  backButton.addEventListener("click", () => {
    url.searchParams.delete("txid");
    url.searchParams.delete("vout");
    window.location.assign(url);
  });
  /** Set submit button text */
  submitButton.innerText = "fetch transaction chain";
  /** Submit button functionality */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const indexer = new RestIndexerProvider(network.operatorUrl);
      const chainTxs = await indexer
        .getVtxoChain({
          txid,
          vout,
        })
        .then(({ chain }) =>
          chain
            .filter((tx) =>
              [
                ChainTxType.TREE,
                ChainTxType.CHECKPOINT,
                ChainTxType.ARK,
              ].includes(tx.type),
            )
            .reverse(),
        );
      const virtualTxs = await indexer
        .getVirtualTxs(chainTxs.map(({ txid }) => txid))
        .then(({ txs }) =>
          txs.map((tx) => Transaction.fromPSBT(base64.decode(tx))),
        );
      const txs = chainTxs.map((chainTx) => {
        const tx = virtualTxs.find((tx) => tx.id === chainTx.txid)!;
        const type =
          chainTx.type === ChainTxType.TREE
            ? "batch-tree"
            : chainTx.type === ChainTxType.CHECKPOINT
              ? "checkpoint"
              : "arkade";
        if (type === "batch-tree") {
          tx.updateInput(0, {
            finalScriptWitness: [tx.getInput(0).tapKeySig!],
          });
        } else {
          tx.finalize();
        }
        return {
          txid: chainTx.txid,
          type,
          hex: tx.hex,
          psbt: base64.encode(tx.toPSBT()),
        } as const;
      });
      const chainTxNodes = txs.map((tx, index) => {
        const chainTxBox = document.createElement("section");
        chainTxBox.setAttribute("box-", "square");
        chainTxBox.setAttribute("shear-", "top");
        chainTxBox.innerHTML = `
<header>
  <span is-="badge" variant-="background0">chain transaction #${index + 1} of ${txs.length}</span>
</header>
<div>
  <label>
    transaction id
    <input id="chain-tx-txid-${index}" type="text" value="${tx.txid}" readonly />
  </label>
  <label>
    type
    <input id="chain-tx-type-${index}" type="text" value="${tx.type}" readonly />
  </label>
  <label>
    hex
    <input id="chain-tx-hex-${index}" type="text" value="${tx.hex}" readonly />
  </label>
  <footer>
    <button type="button" size-="small" data-txid="${tx.txid}" disabled>view on arkade.space</button>
    <button type="button" size-="small" data-txhex="${tx.hex}" disabled>preview on mempool.space</button>
  </footer>
</div>
`;
        return chainTxBox;
      });
      formFooter.before(...chainTxNodes);
      form
        .querySelectorAll<HTMLButtonElement>(
          ":scope > section[box-='square'] > div > footer > button[data-txid]",
        )
        .forEach((button) => {
          button.addEventListener("click", () => {
            const txid = button.getAttribute("data-txid")?.trim() ?? "";
            const explorerUrl = new URL(`${network.explorerUrl}/tx/${txid}`);
            window.open(explorerUrl, "_blank");
          });
          button.disabled = false;
        });
      form
        .querySelectorAll<HTMLButtonElement>(
          ":scope > section[box-='square'] > div > footer > button[data-txhex]",
        )
        .forEach((button) => {
          button.addEventListener("click", () => {
            const txhex = button.getAttribute("data-txhex")?.trim() ?? "";
            const mempoolUrl = new URL(
              `${network.mempoolUrl}/tx/preview#offline=true&tx=${txhex}`,
            );
            window.open(mempoolUrl, "_blank");
          });
          button.disabled = false;
        });
      submitButton.disabled = true;
    } catch {
      throw new Error("failed to fetch virtual transaction chain");
    }
  });
  submitButton.disabled = false;
} else if (
  userPubkey &&
  operatorPubkey &&
  exitTimelock &&
  delegatePubkey &&
  _scripts.size
) {
  /** Remove unneeded inputs */
  [
    userPubkeyInput,
    operatorPubkeyInput,
    exitTimelockInput,
    delegatePubkeyInput,
  ].forEach((input) => input.remove());
  /** Configure back button */
  backButton.addEventListener("click", () => {
    url.searchParams.delete("addresses");
    url.searchParams.delete("scripts");
    window.location.assign(url);
  });
  /** Set submit button text */
  submitButton.innerText = "fetch outputs";
  /** Submit button functionality */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const { vtxos } = await new RestIndexerProvider(
        network.operatorUrl,
      ).getVtxos({
        scripts: Array.from(_scripts.values()),
        spendableOnly: true,
      });
      const outputNodes = vtxos.map((output, index) => {
        const outputBox = document.createElement("section");
        outputBox.setAttribute("box-", "square");
        outputBox.setAttribute("shear-", "top");
        outputBox.innerHTML = `
<header>
  <span is-="badge" variant-="background0">output #${index + 1}</span>
</header>
<div>
  <label>
    transaction id
    <input id="output-txid-${index}" type="text" value="${output.txid}" readonly />
  </label>
  <label>
    output index (vout)
    <input id="output-vout-${index}" type="number" value="${output.vout}" readonly />
  </label>
  <label>
    value
    <input id="output-value-${index}" type="number" value="${output.value}" readonly />
  </label>
  <label>
    virtual status
    <input id="output-state-${index}" type="text" value="${output.virtualStatus.state}" readonly />
  </label>
  <label>
    script
    <input id="output-script-${index}" type="text" value="${output.script}" readonly />
  </label>
  <footer>
    <button type="button" size-="small" data-txid="${output.txid}" data-vout="${output.vout}" disabled>fetch tx chain</button>
    <button type="button" size-="small" data-txid="${output.txid}" disabled>view on arkade.space</button>
  </footer>
</div>
`;
        return outputBox;
      });
      formFooter.before(...outputNodes);
      form
        .querySelectorAll<HTMLButtonElement>(
          ":scope > section[box-='square'] > div > footer > button[data-txid]",
        )
        .forEach((button) => {
          button.addEventListener("click", () => {
            const txid = button.getAttribute("data-txid")?.trim() ?? "";
            const vout = button.getAttribute("data-vout")?.trim() ?? "";
            if (!vout.length) {
              const explorerUrl = new URL(`${network.explorerUrl}/tx/${txid}`);
              window.open(explorerUrl, "_blank");
            } else {
              url.searchParams.append("txid", txid);
              url.searchParams.append("vout", vout);
              window.location.assign(url);
            }
          });
          button.disabled = false;
        });
      submitButton.disabled = true;
    } catch {
      throw new Error("failed to fetch virtual outputs");
    }
  });
  submitButton.disabled = false;
} else if (!userPubkey) {
  const nsecHeading = document.createElement("h2");
  nsecHeading.textContent = "private key";
  const nsecCaption = document.createElement("p");
  nsecCaption.innerHTML = `get your <code>nsec</code> from <a href="https://arkade.money>arkade.money</a> > settings > backup`;
  const nsecInput = document.createElement("input");
  nsecInput.id = "nsec";
  nsecInput.type = "text";
  nsecInput.pattern = "nsec1[023456789acdefghjklmnpqrstuvwxyz]{58}";
  nsecInput.placeholder = "nsec1...";
  nsecInput.autocomplete = "off";
  nsecInput.required = true;
  formFooter.before(nsecHeading, nsecCaption, nsecInput);
  /** Focus input */
  nsecInput.focus();
  /** Set submit button text */
  submitButton.innerText = "extract pubkey";
  /** Submit button functionality */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nsec = nsecInput.value.trim() ?? "";
    try {
      const decoded = nip19.decode(nsec);
      if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) {
        throw new Error("invalid nsec");
      }
      const userPubkey = await SingleKey.fromPrivateKey(
        decoded.data,
      ).xOnlyPublicKey();
      url.searchParams.append("userPubkey", hex.encode(userPubkey));
      window.location.assign(url);
    } catch {
      throw new Error("failed to extract pubkey");
    }
  });
  submitButton.disabled = false;
} else if (!(operatorPubkey && exitTimelock)) {
  /** Configure back button */
  backButton.addEventListener("click", () => {
    url.searchParams.delete("userPubkey");
    window.location.assign(url);
  });
  /** Set submit button text */
  submitButton.innerText = "fetch operator info";
  /** Submit button functionality */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const { signerPubkey, unilateralExitDelay: _exitTimelock } =
        await new RestArkProvider(network.operatorUrl).getInfo();
      const _operatorPubkey = await ReadonlySingleKey.fromPublicKey(
        hex.decode(signerPubkey),
      ).xOnlyPublicKey();
      url.searchParams.append("operatorPubkey", hex.encode(_operatorPubkey));
      url.searchParams.append("exitTimelock", _exitTimelock.toString());
      window.location.assign(url);
    } catch {
      throw new Error("failed to fetch operator info");
    }
  });
  submitButton.disabled = false;
} else if (!delegatePubkey) {
  /** Configure back button */
  backButton.addEventListener("click", () => {
    url.searchParams.delete("operatorPubkey");
    url.searchParams.delete("exitTimelock");
    window.location.assign(url);
  });
  const delegateUrlHeading = document.createElement("h2");
  delegateUrlHeading.textContent = "delegate url";
  const delegateUrlInput = document.createElement("input");
  delegateUrlInput.id = "delegateUrl";
  delegateUrlInput.type = "url";
  delegateUrlInput.placeholder = "https://delegate.example.com";
  delegateUrlInput.value = network.defaultDelegateUrl;
  delegateUrlInput.required = true;
  formFooter.before(delegateUrlHeading, delegateUrlInput);
  /** Focus input */
  delegateUrlInput.focus();
  /** Set submit button text */
  submitButton.innerText = "fetch delegate info";
  /** Submit button functionality */
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const delegateUrl = delegateUrlInput.value.trim() ?? "";
    try {
      const { pubkey } = await new RestDelegateProvider(
        delegateUrl,
      ).getDelegateInfo();
      const _delegatePubkey = await ReadonlySingleKey.fromPublicKey(
        hex.decode(pubkey),
      ).xOnlyPublicKey();
      url.searchParams.append("delegatePubkey", hex.encode(_delegatePubkey));
      window.location.assign(url);
    } catch {
      throw new Error("failed to fetch delegate info");
    }
  });
  submitButton.disabled = false;
}

/** Set button visibility */
if (Object.keys(params).length > 0) {
  backButton.disabled = false;
  resetButton.disabled = false;
}

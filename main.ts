import {
  ArkAddress,
  ChainTxType,
  DefaultVtxo,
  DelegateVtxo,
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

/** Error handling */
window.addEventListener("error", (event) => {
  if (!(errorBox && errorText)) {
    alert(event.error);
  } else {
    errorBox.style.visibility = "visible";
    errorText.innerText = event.error?.message ?? "unknown error, see console";
  }
});
const errorBox = document.querySelector<HTMLElement>(
  "main > section[box-='double'][shear-='top'][variant-='red']",
);
if (!errorBox) throw new Error("Could not find error box");
const errorText = errorBox.querySelector<HTMLParagraphElement>("p");
if (!errorText) throw new Error("Could not find error text");

/** Cache URL */
const url = new URL(window.location.href);

/** Network footer selectors */
const networkFooter = document.querySelector<HTMLElement>("main > footer");
if (!networkFooter) throw new Error("Could not find network footer");
const networkSwitcher = networkFooter.querySelector<HTMLInputElement>(
  "input[type='checkbox']",
);
if (!networkSwitcher) throw new Error("Could not find network switcher");
const networkLabel = networkFooter.querySelector<HTMLParagraphElement>("p");
if (!networkLabel) throw new Error("Could not find network label");

/** Set initial network state */
if (url.searchParams.get("network")?.trim() === "mutinynet") {
  networkLabel.textContent = "network: mutinynet";
} else {
  networkLabel.textContent = "network: mainnet";
  networkSwitcher.checked = true;
}

/** Configure network switcher */
networkSwitcher.addEventListener("change", () => {
  const newUrl = new URL(url);
  /** Wipe network-dependent params */
  newUrl.searchParams.delete("userPubkey");
  newUrl.searchParams.delete("operatorPubkey");
  newUrl.searchParams.delete("exitTimelock");
  newUrl.searchParams.delete("delegatePubkey");
  newUrl.searchParams.delete("addresses");
  /** Save new network */
  if (!networkSwitcher.checked) {
    newUrl.searchParams.append("network", "mutinynet");
  }
  window.location.assign(newUrl);
});
networkFooter.style.visibility = "visible";
networkSwitcher.disabled = false;

/** Recognized form params */
type FormParams = Partial<{
  userPubkey: Uint8Array;
  operatorPubkey: Uint8Array;
  exitTimelock: RelativeTimelock;
  delegatePubkey: Uint8Array;
  /** Above are optional if addresses provided */
  addresses: ArkAddress[];
  /** Above are optional if scripts provided */
  scripts: Uint8Array[];
  /** Above are optional if both txid and vout provided */
  txid: string;
  vout: number;
}>;

const formParamKeys = [
  "userPubkey",
  "operatorPubkey",
  "exitTimelock",
  "delegatePubkey",
  "addresses",
  "scripts",
  "txid",
  "vout",
] as const satisfies readonly (keyof FormParams)[];

const isFormParamKey = (key: string): key is keyof FormParams =>
  formParamKeys.includes(key as keyof FormParams);
const isPubkeyOrTxid = (value: string): boolean =>
  /^[0-9a-fA-F]{64}$/.test(value);
const isExitTimelock = (value: string): boolean =>
  !Number.isNaN(Number(value)) && BigInt(value) >= 86_400n;
const isArkadeAddress = (value: string): boolean => {
  const expectedHrp = networkSwitcher.checked
    ? networks.bitcoin.hrp
    : networks.mutinynet.hrp;
  try {
    return expectedHrp === ArkAddress.decode(value).hrp;
  } catch {
    return false;
  }
};
const isPkScript = (value: string): boolean => /^[0-9a-fA-F]{68}$/.test(value);

/** Parse form params */
const formParams: FormParams = {};
/** De-duplicate plural keys like addresses + scripts */
const uniqueFormParamKeys = new Set(url.searchParams.keys());
/** Exclude 'network' */
uniqueFormParamKeys.delete("network");
for (const key of uniqueFormParamKeys) {
  if (!isFormParamKey(key)) continue;
  const values = url.searchParams.getAll(key);
  const [value] = values;
  if (key === "userPubkey" && isPubkeyOrTxid(value)) {
    formParams[key] = hex.decode(value);
  }
  if (key === "operatorPubkey" && isPubkeyOrTxid(value)) {
    formParams[key] = hex.decode(value);
  }
  if (key === "exitTimelock" && isExitTimelock(value)) {
    formParams[key] = {
      value: BigInt(value),
      type: "seconds",
    };
  }
  if (key === "delegatePubkey" && isPubkeyOrTxid(value)) {
    formParams[key] = hex.decode(value);
  }
  if (key === "addresses") {
    formParams[key] = [];
    for (const value of values) {
      if (!isArkadeAddress(value)) continue;
      formParams[key].push(ArkAddress.decode(value));
    }
  }
  if (key === "scripts") {
    formParams[key] = [];
    for (const value of values) {
      if (!isPkScript(value)) continue;
      formParams[key].push(hex.decode(value));
    }
  }
  if (key === "txid" && isPubkeyOrTxid(value)) {
    formParams[key] = value;
  }
  if (key === "vout" && !Number.isNaN(Number(value)) && Number(value) >= 0) {
    formParams[key] = Number(value);
  }
}

/** Strip out unrecognized form params */
if (uniqueFormParamKeys.size > Object.keys(formParams).length) {
  const newUrl = new URL(url);
  newUrl.search = "";
  /** Retain current network */
  if (!networkSwitcher.checked) {
    newUrl.searchParams.append("network", "mutinynet");
  }
  for (const [key, value] of Object.entries(formParams)) {
    if (typeof value === "undefined") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item instanceof ArkAddress) {
          newUrl.searchParams.append(key, item.encode());
        }
        if (item instanceof Uint8Array) {
          newUrl.searchParams.append(key, hex.encode(item));
        }
      }
      continue;
    }
    if (value instanceof Uint8Array) {
      newUrl.searchParams.set(key, hex.encode(value));
      continue;
    }
    if (
      typeof value === "object" &&
      "value" in value &&
      typeof value.value === "bigint" &&
      "type" in value &&
      value.type === "seconds"
    ) {
      newUrl.searchParams.set(key, value.value.toString());
      continue;
    }
    if (value instanceof Number) {
      newUrl.searchParams.set(key, String(value));
      continue;
    }
    if (value instanceof String) {
      newUrl.searchParams.set(key, String(value));
    }
  }
  /** Reload page */
  window.location.assign(newUrl);
}

/** Form selectors */
const form = document.querySelector<HTMLFormElement>(
  "main > section[box-='double'][shear-='top'] > form",
);
if (!form) throw new Error("Could not find form");
const formDiv = form.querySelector<HTMLDivElement>("div");
if (!formDiv) throw new Error("Could not find form div");
const formFooter = form.querySelector<HTMLElement>("footer");
if (!formFooter) throw new Error("Could not find form footer");
const [submitButton, backButton, resetButton] =
  formFooter.querySelectorAll<HTMLButtonElement>("button");
if ([submitButton, backButton, resetButton].some((el) => !el))
  throw new Error("Could not find form footer buttons");

/** Configure reset button */
resetButton.addEventListener("click", () => {
  const newUrl = new URL(url);
  newUrl.search = "";
  /** Retain current network */
  if (!networkSwitcher.checked) {
    newUrl.searchParams.append("network", "mutinynet");
  }
  window.location.assign(newUrl);
});

/** Set button visibility */
if (Object.keys(formParams).length > 0) {
  backButton.style.display = "inherit";
  backButton.disabled = false;
  resetButton.style.display = "inherit";
  resetButton.disabled = false;
} else {
  backButton.style.display = "none";
  backButton.disabled = true;
  resetButton.style.display = "none";
  resetButton.disabled = true;
}

/** Set primary input behavior */
const setPrimaryInput = (input: HTMLInputElement | null) => {
  input?.focus();
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      form.requestSubmit();
    }
  });
};

const operatorUrl = networkSwitcher.checked
  ? "https://arkade.computer"
  : "https://mutinynet.arkade.sh";

const hrp = networkSwitcher.checked
  ? networks.bitcoin.hrp
  : networks.mutinynet.hrp;

const defaultDelegateUrl = networkSwitcher.checked
  ? "https://delegate.arkade.money"
  : "https://delegator.mutinynet.arkade.sh";

const mempoolUrl = networkSwitcher.checked
  ? "https://mempool.space"
  : "https://mutinynet.com";

if (formParams.txid && formParams.vout) {
  /** Configure back button */
  backButton.addEventListener("click", () => {
    url.searchParams.delete("txid");
    url.searchParams.delete("vout");
    window.location.assign(url);
  });
  const { txid, vout } = formParams;
  formDiv.innerHTML = `
  <p>txid</p>
  <input name="txid" type="text" value="${txid}" readonly />
  <p>vout</p>
  <input name="vout" type="text" value="${vout}" readonly />
  <h4>virtual transaction chain</h4>
  <div>
    <section box-="square">
      <p>transaction id</p>
      <input name="chain-tx-txid" type="text" value="" readonly />
      <p>type</p>
      <input name="chain-tx-type" type="text" value="" readonly />
      <p>hex</p>
      <input name="chain-tx-hex" type="text" value="" readonly />
      <button is-="button" type-="button" size-="small" disabled>view on mempool.space</button>
    </section>
  </div>
  `;
  const txChainDiv = formDiv.querySelector<HTMLDivElement>("div");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!txChainDiv) {
      throw new Error("Could not find tx chain div");
    }
    try {
      const indexer = new RestIndexerProvider(operatorUrl);
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
        const virtualTx = virtualTxs.find((tx) => tx.id === chainTx.txid)!;
        const type =
          chainTx.type === ChainTxType.TREE
            ? "batch-tree"
            : chainTx.type === ChainTxType.CHECKPOINT
              ? "checkpoint"
              : "arkade";
        if (type === "batch-tree") {
          virtualTx.updateInput(0, {
            finalScriptWitness: [virtualTx.getInput(0).tapKeySig!],
          });
        } else {
          virtualTx.finalize();
        }
        return {
          txid: chainTx.txid,
          type,
          hex: virtualTx.hex,
        };
      });
      console.log();
      txChainDiv.innerHTML = txs
        .map(
          (tx, index) =>
            `
    <section box-="square">
      <p>transaction id</p>
      <input name="chain-tx-txid-${index}" type="text" value="${tx.txid}" readonly />
      <p>type</p>
      <input name="chain-tx-type-${index}" type="text" value="${tx.type}" readonly />
      <p>hex</p>
      <input name="chain-tx-hex-${index}" type="text" value="${tx.hex}" readonly />
      <button is-="button" type-="button" size-="small" data-txhex="${tx.hex}">view on mempool.space</button>
    </section>
    `,
        )
        .join("");
      txChainDiv
        .querySelectorAll<HTMLButtonElement>("button[data-txhex]")
        .forEach((button) => {
          button.addEventListener("click", () => {
            const txhex = button.getAttribute("data-txhex")?.trim() ?? "";
            const newUrl = new URL(
              `${mempoolUrl}/tx/preview#offline=true&tx=${txhex}`,
            );
            window.open(newUrl, "_blank");
          });
        });
      submitButton.innerText = "reload transaction chain";
      submitButton.setAttribute("variant-", "background1");
    } catch {
      throw new Error("failed to fetch virtual transaction chain");
    }
  });
  submitButton.innerText = "fetch transaction chain";
  submitButton.style.visibility = "visible";
  submitButton.disabled = false;
} else if (formParams.addresses?.length || formParams.scripts?.length) {
  /** Configure back button */
  backButton.addEventListener("click", () => {
    url.searchParams.delete("addresses");
    url.searchParams.delete("scripts");
    window.location.assign(url);
  });
  const {
    userPubkey,
    operatorPubkey,
    delegatePubkey,
    exitTimelock,
    addresses,
    scripts,
  } = formParams;
  formDiv.innerHTML = `
  <p>user pubkey (x-only)</p>
  <input name="userPubkey" type="text" value="${userPubkey ? hex.encode(userPubkey) : ""}" readonly />
  <p>operator pubkey (x-only)</p>
  <input name="operatorPubkey" type="text" value="${operatorPubkey ? hex.encode(operatorPubkey) : ""}" readonly />
  <p>exit timelock (seconds)</p>
  <input name="exitTimelock" type="number" value="${exitTimelock ? exitTimelock.value.toString() : ""}" readonly />
  <p>delegate pubkey (x-only)</p>
  <input name="delegatePubkey" type="text" value="${delegatePubkey ? hex.encode(delegatePubkey) : ""}" readonly />
  <h5>addresses</h5>
  ${addresses?.length ? addresses.map((address, index) => `<input name="address-${index}" type="text" value="${address.encode()}" readonly />`).join("") : `<input name="address" type="text" value="" readonly />`}
  <h5>scripts</h5>
  ${scripts?.length ? scripts.map((script, index) => `<input name="script-${index}" type="text" value="${hex.encode(script)}" readonly />`).join("") : `<input name="script" type="text" value="" readonly />`}
  <h4>virtual outputs</h4>
  <div>
    <section box-="square">
      <p>transaction id</p>
      <input name="output-txid" type="text" value="" readonly />
      <p>output index (vout)</p>
      <input name="output-vout" type="number" value="" readonly />
      <p>value</p>
      <input name="output-value" type="number" value="" readonly />
      <p>virtual status</p>
      <input name="output-state" type="text" value="" readonly />
      <p>script</p>
      <input name="output-script" type="text" value="" readonly />
      <button is-="button" type-="button" size-="small" disabled>view transaction chain</button>
    </section>
  </div>
  `;
  const outputsDiv = formDiv.querySelector<HTMLDivElement>("div");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const _scripts =
      scripts?.map((script) => hex.encode(script)) ??
      addresses?.map((address) => hex.encode(address.pkScript));
    if (!_scripts) {
      throw new Error("Could not extract scripts");
    }
    if (!outputsDiv) {
      throw new Error("Could not find outputs div");
    }
    try {
      const { vtxos } = await new RestIndexerProvider(operatorUrl).getVtxos({
        scripts: _scripts,
        spendableOnly: true,
      });
      console.log();
      outputsDiv.innerHTML = vtxos
        .map(
          (output, index) =>
            `
    <section box-="square">
      <p>transaction id</p>
      <input name="output-txid-${index}" type="text" value="${output.txid}" readonly />
      <p>output index (vout)</p>
      <input name="output-vout-${index}" type="number" value="${output.vout}" readonly />
      <p>value</p>
      <input name="output-value-${index}" type="number" value="${output.value}" readonly />
      <p>virtual status</p>
      <input name="output-state-${index}" type="text" value="${output.virtualStatus.state}" readonly />
      <p>script</p>
      <input name="output-script-${index}" type="text" value="${output.script}" readonly />
      <button is-="button" type-="button" size-="small" data-txid="${output.txid}" data-vout="${output.vout}">view transaction chain</button>
    </section>
    `,
        )
        .join("");
      submitButton.innerText = "reload outputs";
      submitButton.setAttribute("variant-", "background1");
      outputsDiv
        .querySelectorAll<HTMLButtonElement>("button[data-txid][data-vout]")
        .forEach((button) => {
          button.addEventListener("click", () => {
            const txid = button.getAttribute("data-txid")?.trim() ?? "";
            const vout = button.getAttribute("data-vout")?.trim() ?? "";
            url.searchParams.append("txid", txid);
            url.searchParams.append("vout", vout);
            window.location.assign(url);
          });
        });
    } catch {
      throw new Error("failed to fetch virtual outputs");
    }
  });
  submitButton.innerText = "fetch outputs";
  submitButton.style.visibility = "visible";
  submitButton.disabled = false;
} else if (!formParams.userPubkey) {
  const { addresses, scripts } = formParams;
  formDiv.innerHTML = `
  <p>user pubkey (x-only)</p>
  <input name="userPubkey" type="text" value="" readonly />
  <p>operator pubkey (x-only)</p>
  <input name="operatorPubkey" type="text" value="" readonly />
  <p>exit timelock (seconds)</p>
  <input name="exitTimelock" type="number" value="" readonly />
  <p>delegate pubkey (x-only)</p>
  <input name="delegatePubkey" type="text" value="" readonly />
  <h5>addresses</h5>
  ${addresses?.length ? addresses.map((address, index) => `<input name="address-${index}" type="text" value="${address.encode()}" readonly />`).join("") : `<input name="address" type="text" value="" readonly />`}
  <h5>scripts</h5>
  ${scripts?.length ? scripts.map((script, index) => `<input name="script-${index}" type="text" value="${hex.encode(script)}" readonly />`).join("") : `<input name="script" type="text" value="" readonly />`}
  <h4>private key</h4>
  <p>get your <code>nsec</code> from <a href="https://arkade.money">arkade.money</a> > settings > backup</p>
  <input name="nsec" type="text" placeholder="nsec1..." autocomplete="off" required />
  `;
  const input = formDiv.querySelector<HTMLInputElement>("input[name='nsec']");
  setPrimaryInput(input);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nsec = input?.value.trim() ?? "";
    if (!nsec) {
      throw new Error("missing nsec");
    }
    try {
      if (isPubkeyOrTxid(nsec)) {
        const userPubkey = await SingleKey.fromHex(nsec).xOnlyPublicKey();
        url.searchParams.append("userPubkey", hex.encode(userPubkey));
        window.location.assign(url);
      }
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
  submitButton.innerText = "extract pubkey";
  submitButton.style.visibility = "visible";
  submitButton.disabled = false;
} else if (!(formParams.operatorPubkey && formParams.exitTimelock)) {
  /** Configure back button */
  backButton.addEventListener("click", () => {
    url.searchParams.delete("userPubkey");
    window.location.assign(url);
  });
  const { userPubkey, addresses, scripts } = formParams;
  formDiv.innerHTML = `
  <p>user pubkey (x-only)</p>
  <input name="userPubkey" type="text" value="${hex.encode(userPubkey)}" readonly />
  <p>operator pubkey (x-only)</p>
  <input name="operatorPubkey" type="text" value="" readonly />
  <p>exit timelock (seconds)</p>
  <input name="exitTimelock" type="number" value="" readonly />
  <p>delegate pubkey (x-only)</p>
  <input name="delegatePubkey" type="text" value="" readonly />
  <h5>addresses</h5>
  ${addresses?.length ? addresses.map((address, index) => `<input name="address-${index}" type="text" value="${address.encode()}" readonly />`).join("") : `<input name="address" type="text" value="" readonly />`}
  <h5>scripts</h5>
  ${scripts?.length ? scripts.map((script, index) => `<input name="script-${index}" type="text" value="${hex.encode(script)}" readonly />`).join("") : `<input name="script" type="text" value="" readonly />`}
  `;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const { signerPubkey, unilateralExitDelay } = await new RestArkProvider(
        operatorUrl,
      ).getInfo();
      const operatorPubkey = await ReadonlySingleKey.fromPublicKey(
        hex.decode(signerPubkey),
      ).xOnlyPublicKey();
      url.searchParams.append("operatorPubkey", hex.encode(operatorPubkey));
      url.searchParams.append("exitTimelock", unilateralExitDelay.toString());
      window.location.assign(url);
    } catch {
      throw new Error("failed to fetch operator info");
    }
  });
  submitButton.innerText = "fetch operator info";
  submitButton.style.visibility = "visible";
  submitButton.disabled = false;
} else if (!formParams.delegatePubkey) {
  /** Configure back button */
  backButton.addEventListener("click", () => {
    url.searchParams.delete("operatorPubkey");
    url.searchParams.delete("exitTimelock");
    window.location.assign(url);
  });
  const { userPubkey, operatorPubkey, exitTimelock, addresses, scripts } =
    formParams;
  const _addresses = addresses ?? [];
  const _scripts = scripts ?? [];
  const defaultAddress = new DefaultVtxo.Script({
    pubKey: userPubkey,
    serverPubKey: operatorPubkey,
    csvTimelock: exitTimelock,
  }).address(hrp, operatorPubkey);
  if (
    !_addresses.find((address) => address.encode() === defaultAddress.encode())
  ) {
    _addresses.push(defaultAddress);
    url.searchParams.append("addresses", defaultAddress.encode());
  }
  if (
    !_scripts.find(
      (script) => hex.encode(script) === hex.encode(defaultAddress.pkScript),
    )
  ) {
    _scripts.push(defaultAddress.pkScript);
    url.searchParams.append("scripts", hex.encode(defaultAddress.pkScript));
  }
  formDiv.innerHTML = `
  <p>user pubkey (x-only)</p>
  <input name="userPubkey" type="text" value="${hex.encode(userPubkey)}" readonly />
  <p>operator pubkey (x-only)</p>
  <input name="operatorPubkey" type="text" value="${hex.encode(operatorPubkey)}" readonly />
  <p>exit timelock (seconds)</p>
  <input name="exitTimelock" type="number" value="${exitTimelock.value.toString()}" readonly />
  <p>delegate pubkey (x-only)</p>
  <input name="delegatePubkey" type="text" value="" readonly />
  <h5>addresses</h5>
  ${_addresses.length ? _addresses.map((address, index) => `<input name="address-${index}" type="text" value="${address.encode()}" readonly />`).join("") : `<input name="address" type="text" value="" readonly />`}
  <h5>scripts</h5>
  ${_scripts.length ? _scripts.map((script, index) => `<input name="script-${index}" type="text" value="${hex.encode(script)}" readonly />`).join("") : `<input name="script" type="text" value="" readonly />`}
  <h4>delegate url</h4>
  <input name="delegateUrl" type="url" placeholder="https://delegate.example.com" value="${defaultDelegateUrl}" required />
  `;
  const input = formDiv.querySelector<HTMLInputElement>(
    "input[name='delegateUrl']",
  );
  setPrimaryInput(input);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const delegateUrl = input?.value.trim() ?? "";
    if (!delegateUrl) {
      throw new Error("missing delegate url");
    }
    try {
      const { pubkey } = await new RestDelegateProvider(
        delegateUrl,
      ).getDelegateInfo();
      const delegatePubkey = await ReadonlySingleKey.fromPublicKey(
        hex.decode(pubkey),
      ).xOnlyPublicKey();
      url.searchParams.append("delegatePubkey", hex.encode(delegatePubkey));
      const delegatedAddress = new DelegateVtxo.Script({
        pubKey: userPubkey,
        serverPubKey: operatorPubkey,
        delegatePubKey: delegatePubkey,
        csvTimelock: exitTimelock,
      }).address(hrp, operatorPubkey);
      if (
        !addresses?.find(
          (address) => address.encode() === delegatedAddress.encode(),
        )
      ) {
        url.searchParams.append("addresses", delegatedAddress.encode());
      }
      if (
        !scripts?.find(
          (script) =>
            hex.encode(script) === hex.encode(delegatedAddress.pkScript),
        )
      ) {
        url.searchParams.append(
          "scripts",
          hex.encode(delegatedAddress.pkScript),
        );
      }
      window.location.assign(url);
    } catch {
      throw new Error("failed to fetch delegate info");
    }
  });
  submitButton.innerText = "fetch delegate info";
  submitButton.style.visibility = "visible";
  submitButton.disabled = false;
}

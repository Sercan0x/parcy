"use client";

import { useState, useMemo } from "react";
import { ethers } from "ethers";

const PAYARC_ADDRESS = "0xcF639C19973eB9E3E7BC1226313344eD7Ff4b52B";
const USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
const RPC_URL = "https://rpc.testnet.arc.network";
const EXPLORER_BASE_URL = "https://testnet.arcscan.app/tx/";

const PAYARC_ABI = [
  "function owner() view returns(address)",
  "function creatorPrefix(address) view returns(string)",
  "function getPrefix(address) view returns (string)",
  "function createInvoice(string id,uint256 amount,string description) external",
  "function getInvoice(string id) view returns (uint256 amount,address issuer,bool paid,address payer,uint256 paidAt,string description)",
  "function editInvoice(string oldId,string newId,uint256 newAmount,string newDescription) external",
  "function deleteInvoice(string id) external",
  "function payInvoice(string id) external",
  "event InvoicePaid(bytes32 indexed idHash, string id, uint256 amount, address payer)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) external returns (bool)",
  "function decimals() view returns (uint8)",
];

const rpcProvider = new ethers.JsonRpcProvider(RPC_URL);
const readPayArc = new ethers.Contract(PAYARC_ADDRESS, PAYARC_ABI, rpcProvider);

export default function Page() {
  const [wallet, setWallet] = useState(null);
  const [payArc, setPayArc] = useState(null);
  const [usdc, setUsdc] = useState(null);
  const [log, setLog] = useState("Ready.\nUI initialized.");
  const [canCreate, setCanCreate] = useState(false);

  const [currentPage, setCurrentPage] = useState("pay");

  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState(false);
  const [approving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);

  const [decimals, setDecimals] = useState(6);

  const [newId, setNewId] = useState("");
  const [newAmount, setNewAmount] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const [lookupId, setLookupId] = useState("");
  const [invoice, setInvoice] = useState(null);
  const [lastTxHash, setLastTxHash] = useState(null);

  const [manageId, setManageId] = useState("");
  const [managedInvoice, setManagedInvoice] = useState(null);
  const [editMode, setEditMode] = useState(false);
  const [editNewId, setEditNewId] = useState("");
  const [editNewAmount, setEditNewAmount] = useState("");
  const [editNewDesc, setEditNewDesc] = useState("");

  const [txHashCache, setTxHashCache] = useState({});

  function appendLog(msg) {
    setLog((prev) => prev + "\n" + msg);
  }

  async function connectWallet() {
    try {
      if (!window.ethereum) {
        appendLog("No wallet detected.");
        return;
      }

      await window.ethereum.request({ method: "eth_requestAccounts" });

      const provider = new ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      const address = await signer.getAddress();

      const payArcWrite = new ethers.Contract(PAYARC_ADDRESS, PAYARC_ABI, signer);
      const usdcWrite = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);

      setWallet(address);
      setPayArc(payArcWrite);
      setUsdc(usdcWrite);

      appendLog("Wallet connected: " + address);

      try {
        const d = await usdcWrite.decimals();
        setDecimals(Number(d));
      } catch {
        setDecimals(6);
      }

      await checkIssuerAccess(payArcWrite, address);
    } catch (e) {
      console.error(e);
      appendLog("Connect failed.");
    }
  }

  async function checkIssuerAccess(contract, address) {
    try {
      const owner = await readPayArc.owner();
      let prefix = "";

      try {
        prefix = await readPayArc.getPrefix(address);
      } catch {
        prefix = "";
      }

      const isOwner = owner.toLowerCase() === address.toLowerCase();
      const hasPrefix = prefix && prefix.length > 0;

      if (isOwner || hasPrefix) {
        setCanCreate(true);
        appendLog("Authorized creator.");
      } else {
        setCanCreate(false);
        appendLog("You are not authorized to create invoices.");
      }
    } catch {
      appendLog("Issuer check error.");
    }
  }

  async function handleCreateInvoice() {
    if (!wallet) return appendLog("Connect wallet first.");
    if (!canCreate) return appendLog("Not allowed to create.");
    if (!newId || !newAmount) return appendLog("ID and amount required.");

    try {
      setCreating(true);
      const amount = ethers.parseUnits(newAmount, decimals);

      appendLog("Creating invoice " + newId + " ...");

      const tx = await payArc.createInvoice(newId, amount, newDesc);
      appendLog("Tx sent: " + tx.hash);
      await tx.wait();

      appendLog("Invoice created successfully.");
      setNewId("");
      setNewAmount("");
      setNewDesc("");
    } catch (e) {
      appendLog("Create failed: " + (e.reason || e.message));
    } finally {
      setCreating(false);
    }
  }

  async function lookupInvoice(id) {
    if (!id.trim()) {
      appendLog("Invoice ID is empty.");
      return null;
    }
    const trimmedId = id.trim();

    try {
      appendLog("Loading invoice: " + trimmedId);

      const [amount, issuer, paid, payer, paidAt, description] =
        await readPayArc.getInvoice(trimmedId);

      if (issuer === ethers.ZeroAddress) {
        appendLog("Invoice not found.");
        return null;
      }

      const amountFormatted = ethers.formatUnits(amount, decimals);
      const invoiceData = {
        id: trimmedId,
        amountRaw: amount,
        amountFormatted,
        issuer,
        paid,
        payer,
        description,
        paidAt
      };

      appendLog("Invoice loaded.");
      return invoiceData;
    } catch {
      appendLog("Error loading invoice.");
      return null;
    }
  }

  async function handlePayLookup() {
    const result = await lookupInvoice(lookupId);
    setInvoice(result);
    setLastTxHash(result?.txHash || null);
  }

  async function handlePayOneClick() {
    if (!wallet) return appendLog("Connect wallet first.");
    if (!invoice) return appendLog("Lookup an invoice first.");

    try {
      setPaying(true);

      const fee = invoice.amountRaw / BigInt(100);
      const totalRequired = invoice.amountRaw + fee;

      appendLog(`Total payment: ${ethers.formatUnits(totalRequired, decimals)} USDC`);

      const allowance = await usdc.allowance(wallet, PAYARC_ADDRESS);

      if (allowance < totalRequired) {
        appendLog("🔒 Not enough allowance. Approving first...");

        const txApprove = await usdc.approve(PAYARC_ADDRESS, totalRequired);
        appendLog("✔ Approve tx sent: " + txApprove.hash);

        await txApprove.wait();
        appendLog("✔ Approve confirmed.");
      } else {
        appendLog("✔ Already approved. Skipping approve step.");
      }

      appendLog("💳 Paying invoice...");
      const txPay = await payArc.payInvoice(invoice.id);
      const actualTxHash = txPay.hash;
      setLastTxHash(actualTxHash);
      setTxHashCache(prev => ({...prev, [invoice.id]: actualTxHash}));

      appendLog("✔ Pay tx sent: " + actualTxHash);

      await txPay.wait();
      appendLog("🎉 Invoice paid. Tx confirmed.");

      await handlePayLookup();

    } catch (e) {
      appendLog("❌ Payment failed: " + (e.reason || e.message));
      setLastTxHash(null);
    } finally {
      setPaying(false);
    }
  }

  async function handleManageLookup() {
    const result = await lookupInvoice(manageId);
    setManagedInvoice(result);
    setEditMode(false);
    if (result) {
      setEditNewId(result.id);
      setEditNewAmount(result.amountFormatted);
      setEditNewDesc(result.description || "");
    } else {
      setEditNewId("");
      setEditNewAmount("");
      setEditNewDesc("");
    }
  }

  async function handleDeleteInvoice() {
    if (!wallet) return appendLog("Connect wallet first.");
    if (!managedInvoice || managedInvoice.paid) return appendLog("Cannot delete.");
    if (managedInvoice.issuer.toLowerCase() !== wallet.toLowerCase()) return appendLog("Only issuer.");

    try {
      setDeleting(true);
      appendLog("Deleting invoice " + managedInvoice.id + "...");

      const tx = await payArc.deleteInvoice(managedInvoice.id);
      appendLog("Delete Tx sent: " + tx.hash);
      await tx.wait();

      appendLog("Invoice deleted successfully.");
      setManagedInvoice(null);
      setManageId("");
    } catch (e) {
      appendLog("Delete failed: " + (e.reason || e.message));
    } finally {
      setDeleting(false);
    }
  }

  async function handleEditInvoice() {
    if (!wallet) return appendLog("Connect wallet first.");
    if (!managedInvoice) return appendLog("Invoice not loaded.");
    if (managedInvoice.issuer.toLowerCase() !== wallet.toLowerCase()) return appendLog("Only issuer.");
    if (managedInvoice.paid) return appendLog("Cannot edit.");
    if (!editNewId.trim() || !editNewAmount.trim()) return appendLog("Required.");

    const oldId = managedInvoice.id;
    const newIdValue = editNewId.trim();
    const newDescValue = editNewDesc.trim();

    try {
      setEditing(true);
      const newAmountValue = ethers.parseUnits(editNewAmount, decimals);

      appendLog(`Editing invoice ${oldId} → ${newIdValue}...`);

      const tx = await payArc.editInvoice(oldId, newIdValue, newAmountValue, newDescValue);
      appendLog("Edit Tx sent: " + tx.hash);
      await tx.wait();

      appendLog("✓ Invoice edited successfully!");
      setManageId(newIdValue);

      await new Promise(resolve => setTimeout(resolve, 2000));

      appendLog(`Fetching invoice with new ID: ${newIdValue}`);
      const refreshedInvoice = await lookupInvoice(newIdValue);

      if (refreshedInvoice) {
        setManagedInvoice(refreshedInvoice);
        setEditNewId(refreshedInvoice.id);
        setEditNewAmount(refreshedInvoice.amountFormatted);
        setEditNewDesc(refreshedInvoice.description || "");
        appendLog(`✓ Successfully loaded invoice with ID: ${newIdValue}`);
      }

      setEditMode(false);
    } catch (e) {
      appendLog("Edit failed: " + (e.reason || e.message));
    } finally {
      setEditing(false);
    }
  }

  const shortWallet = wallet ? wallet.slice(0, 6) + "..." + wallet.slice(-4) : "";

  const renderContent = useMemo(() => {
    switch (currentPage) {
      case "pay":
        return (
          <>
            <section className="panel">
              <h3>Invoice Lookup & Payment</h3>
              <p className="sub">
                Enter an invoice ID to check its status and make a payment using USDC.
              </p>

              <label>Invoice ID</label>
              <input
                value={lookupId}
                onChange={(e) => setLookupId(e.target.value)}
                placeholder="INV-001"
              />

              <button className="primary" onClick={handlePayLookup}>
                Lookup Invoice
              </button>

              {invoice && (
                <div className="invoice-details-box modern-card">
                  <h4 className="card-title">
                    Invoice Details <span className="invoice-id">#{invoice.id}</span>
                  </h4>

                  <div
                    className="status-badge"
                    style={{
                      backgroundColor: invoice.paid ? 'rgba(74, 222, 128, 0.1)' : 'rgba(248, 113, 113, 0.1)',
                      color: invoice.paid ? '#4ade80' : '#f87171',
                      fontWeight: 'bold',
                      padding: '6px 10px',
                      borderRadius: '4px',
                      marginBottom: '15px',
                      textAlign: 'center',
                      border: invoice.paid ? '1px solid #4ade80' : '1px solid #f87171',
                    }}
                  >
                    {invoice.paid ? 'PAID' : 'UNPAID'}
                  </div>

                  <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px', fontSize: 13 }}>
                    <div className="detail-item">
                      <div className="label">Amount</div>
                      <div className="value amount-value"><b>{invoice.amountFormatted} USDC</b></div>
                    </div>
                    <div className="detail-item">
                      <div className="label">Description</div>
                      <div className="value">{invoice.description}</div>
                    </div>
                    <div className="detail-item">
                      <div className="label">Issuer</div>
                      <div className="value address-value">{invoice.issuer.slice(0, 6)}...{invoice.issuer.slice(-4)}</div>
                    </div>
                    <div className="detail-item">
                      <div className="label">Payer</div>
                      <div className="value address-value">{invoice.payer?.slice?.(0, 6)}...{invoice.payer?.slice?.(-4)}</div>
                    </div>
                  </div>

                  <div style={{ marginTop: 25, paddingTop: 15, borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                    {!invoice.paid ? (
                      <button
                        className="primary"
                        onClick={handlePayOneClick}
                        disabled={paying || !wallet}
                      >
                        {paying ? "Processing..." : "Pay Invoice"}
                      </button>
                    ) : (
                      <span style={{ fontSize: 12, color: "#4ade80" }}>
                        Transaction successful.
                      </span>
                    )}
                  </div>
                </div>
              )}
            </section>
          </>
        );
      case "create":
      case "manage":
      case "about":
        return (<></>);
      default:
        return null;
    }
  }, [currentPage, invoice, lookupId, managedInvoice, manageId, editMode, editNewId, editNewAmount, editNewDesc, newId, newAmount, newDesc, canCreate, creating, paying, deleting, wallet, decimals, lastTxHash, usdc, payArc]);

  return (
    <div className="app">
      {/* Aynı HTML sidebar, header, log panel içeriği burada aynen kalıyor */}
    </div>
  );
}

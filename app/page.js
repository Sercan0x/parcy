
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
  const [approving, setApproving] = useState(false);
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
      } catch (e) {
        appendLog("Warning: Could not read creator prefix. Defaulting to empty prefix.");
        console.error("Prefix read error:", e);
        prefix = "";
      }

      const isOwner = owner.toLowerCase() === address.toLowerCase();
      const hasPrefix = prefix && prefix.length > 0;

      if (isOwner) {
        setCanCreate(true);
        appendLog("You are contract owner — full permissions.");
      } else if (hasPrefix) {
        setCanCreate(true);
        appendLog("Authorized creator with prefix: " + prefix);
      } else {
        setCanCreate(false);
        appendLog("You are not authorized to create invoices.");
      }
    } catch (e) {
      appendLog("Issuer check error.");
      console.error(e);
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
      console.error(e);
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
      const paidAtNum = Number(paidAt);
      const paidAtStr =
        paidAtNum > 0
          ? new Date(paidAtNum * 1000).toISOString().replace("T", " ").slice(0, 16)
          : "-";

      let foundTxHash = null;

      if (paid) {      
          if (txHashCache[trimmedId]) {
              foundTxHash = txHashCache[trimmedId];
              appendLog(`Tx Hash from cache: ${foundTxHash.slice(0, 10)}...`);
          } else {
              try {
                const currentBlock = await rpcProvider.getBlockNumber();
                const maxSearchBlocks = 100000000; // Search up to 10M blocks back
                const chunkSize = 10000; // RPC limit
                
                const idHash = ethers.id(trimmedId);
                let searchFromBlock = currentBlock - chunkSize;
                let attempts = 0;
                const maxAttempts = Math.ceil(maxSearchBlocks / chunkSize);
                
                appendLog(`Searching for payment tx (up to ${maxSearchBlocks} blocks back)...`);
                
                while (!foundTxHash && attempts < maxAttempts && searchFromBlock > 0) {
                  attempts++;
                  const fromBlock = Math.max(0, searchFromBlock);
                  const toBlock = fromBlock + chunkSize;
                  
                  if (attempts > 1) {
                    appendLog(`  Checking blocks ${fromBlock} - ${toBlock}...`);
                  }
                  
                  const filter = readPayArc.filters.InvoicePaid(idHash);
                  const events = await readPayArc.queryFilter(filter, fromBlock, toBlock);
                  
                  if (events.length > 0) {
                    foundTxHash = events[0].transactionHash;
                    setTxHashCache(prev => ({...prev, [trimmedId]: foundTxHash}));
                    appendLog(`✓ Tx Hash found at block ~${events[0].blockNumber}: ${foundTxHash.slice(0, 10)}...`);
                    break;
                  }
                  
                  searchFromBlock -= chunkSize;
                  
                  if (attempts % 3 === 0) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                  }
                }
                
                if (!foundTxHash) {
                  appendLog(`⚠ Payment tx not found in last ${maxSearchBlocks} blocks.`);
                }
              } catch (err) {
                console.error("Event lookup error:", err);
                appendLog(`Event search failed: ${err.message}`);
              }
          }
      }

      const invoiceData = {
        id: trimmedId,
        amountRaw: amount,
        amountFormatted,
        issuer,
        paid,
        payer,
        paidAt: paidAtStr,
        description,
        txHash: foundTxHash,
      };

      appendLog("Invoice loaded.");
      return invoiceData;

    } catch (e) {
      console.error(e);
      appendLog("Error loading invoice.");
      return null;
    }
  }

  async function handlePayLookup() {
      const result = await lookupInvoice(lookupId);
      setInvoice(result);
      setLastTxHash(result?.txHash || null);
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

  async function handleApprove() {
    if (!wallet) return appendLog("Connect wallet first.");
    if (!invoice) return appendLog("Lookup an invoice first.");

    try {
      setApproving(true);
      appendLog("Approving USDC...");

      const fee = invoice.amountRaw / BigInt(100);
      const totalAmountToApprove = invoice.amountRaw + fee;
      
      const tx = await usdc.approve(PAYARC_ADDRESS, totalAmountToApprove);
      
      appendLog("Approve tx: " + tx.hash);
      await tx.wait();

      appendLog("USDC approved for total payment amount.");
    } catch (e) {
      console.error(e);
      appendLog("Approve failed.");
    } finally {
      setApproving(false);
    }
  }

  async function handlePay() {
    if (!wallet) return appendLog("Connect wallet first.");
    if (!invoice) return appendLog("Lookup an invoice first.");

    try {
      setPaying(true);

      const fee = invoice.amountRaw / BigInt(100);
      const totalRequired = invoice.amountRaw + fee;
      
      const allowance = await usdc.allowance(wallet, PAYARC_ADDRESS);
      
      if (allowance < totalRequired) {
          appendLog("Approving USDC...");
          const approveTx = await usdc.approve(PAYARC_ADDRESS, totalRequired);
          appendLog("Approve tx: " + approveTx.hash);
          await approveTx.wait();
          appendLog("USDC approved.");
      }

      appendLog("Paying invoice ...");
      const tx = await payArc.payInvoice(invoice.id);
      
      const actualTxHash = tx.hash;
      setLastTxHash(actualTxHash);
      setTxHashCache(prev => ({...prev, [invoice.id]: actualTxHash}));
      appendLog("Pay tx sent: " + actualTxHash);

      await tx.wait();

      appendLog("Invoice paid. Tx confirmed.");
      
      await handlePayLookup();
      
    } catch (e) {
      console.error(e);
      appendLog("Payment failed: " + (e.reason || e.message));
      setLastTxHash(null);
    } finally {
      setPaying(false);
    }
  }

  async function handleDeleteInvoice() {
    if (!wallet) return appendLog("Connect wallet first.");
    if (!managedInvoice || managedInvoice.paid) return appendLog("Cannot delete: Invoice not loaded or already paid.");
    if (managedInvoice.issuer.toLowerCase() !== wallet.toLowerCase()) return appendLog("Cannot delete: Only the issuer can delete this invoice.");

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
      console.error(e);
      appendLog("Delete failed: " + (e.reason || e.message));
    } finally {
      setDeleting(false);
    }
  }
  
  async function handleEditInvoice() {
      if (!wallet) return appendLog("Connect wallet first.");
      if (!managedInvoice) return appendLog("Invoice not loaded.");
      if (managedInvoice.issuer.toLowerCase() !== wallet.toLowerCase()) return appendLog("Cannot edit: Only the issuer can edit this invoice.");
      if (managedInvoice.paid) return appendLog("Cannot edit: Paid invoices cannot be edited.");
      if (!editNewId.trim() || !editNewAmount.trim()) return appendLog("New ID and Amount required.");

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

          appendLog("✓ Invoice edited successfully on blockchain!");
          appendLog(`Old ID "${oldId}" deleted, new ID "${newIdValue}" created.`);
          
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
          } else {
              appendLog("⚠ Automatic reload failed. Please manually lookup with new ID: " + newIdValue);
              setManagedInvoice(null);
          }

          setEditMode(false);

      } catch (e) {
          console.error(e);
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
                      <div className="value amount-value">**{invoice.amountFormatted} USDC**</div>
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
                      <div className="value address-value">{invoice.payer.slice(0, 6)}...{invoice.payer.slice(-4)}</div>
                    </div>
                    <div className="detail-item" style={{ gridColumn: 'span 2' }}>
                      <div className="label">Paid at</div>
                      <div className="value">{invoice.paidAt}</div>
                    </div>

                    {invoice.paid && invoice.txHash && (
                      <div className="detail-item" style={{ gridColumn: 'span 2' }}>
                        <div className="label">Tx Hash</div>
                        <div className="value tx-hash-value" style={{ fontSize: 10, wordBreak: 'break-all' }}>
                          <a
                            href={`${EXPLORER_BASE_URL}${invoice.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#4ade80', textDecoration: 'underline' }}
                          >
                            {invoice.txHash}
                          </a>
                        </div>
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 25, paddingTop: 15, borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                    {!invoice.paid ? (
                      <>
                        <button
                          className="primary"
                          onClick={handlePay}
                          disabled={paying || !wallet}                          
                        >
                          {paying ? "Paying..." : "Pay Invoice"}
                        </button>
                      </>
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
        return (
          <>
            <section className="panel">
              <h3>Create New Invoice</h3>
              <p className="sub">
                Only authorized creators (owner or prefix holder) can issue new invoices.
              </p>

              <label>Invoice ID</label>
              <input
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
                placeholder="INV-001"
              />

              <label>Amount (USDC)</label>
              <input
                type="number"
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                placeholder="100.00"
              />

              <label>Description</label>
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Service rendered on [Date]"
              />

              <button
                className="primary"
                onClick={handleCreateInvoice}
                disabled={creating || !wallet || !canCreate}
              >
                {creating
                  ? "Creating..."
                  : wallet
                  ? canCreate
                    ? "Create Invoice"
                    : "Not Authorized"
                  : "Connect Wallet"}
              </button>
              {!canCreate && wallet && (
                  <p style={{fontSize: 12, color: '#f87171', marginTop: 8}}>
                      Your wallet is not authorized to create invoices on this contract.
                  </p>
              )}
            </section>
          </>
        );
      case "manage":
        return (
          <>
            <section className="panel">
              <h3>Manage Invoices (Edit / Cancel)</h3>
              <p className="sub">
                Search for an invoice you issued to manage its details or cancel it.
              </p>

              <label>Invoice ID</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={manageId}
                  onChange={(e) => setManageId(e.target.value)}
                  placeholder="INV-001"
                  style={{marginBottom: 0}}
                />
                 <button className="action" onClick={handleManageLookup} style={{ flexShrink: 0, minWidth: 100 }}>
                    Lookup
                </button>
                <button 
                  className="action" 
                  onClick={async () => {
                    if (!manageId.trim()) return appendLog("Enter an ID first");
                    try {
                      appendLog(`🔍 DEBUG: Direct contract call for "${manageId.trim()}"`);
                      const [amount, issuer, paid, payer, paidAt, description] = await readPayArc.getInvoice(manageId.trim());
                      appendLog(`Raw response:`);
                      appendLog(`  amount: ${amount.toString()}`);
                      appendLog(`  issuer: ${issuer}`);
                      appendLog(`  paid: ${paid}`);
                      appendLog(`  Is ZeroAddress: ${issuer === ethers.ZeroAddress}`);
                      if (issuer === ethers.ZeroAddress) {
                        appendLog("❌ Invoice NOT FOUND in contract");
                      } else {
                        appendLog("✅ Invoice FOUND in contract!");
                        appendLog(`  Formatted: ${ethers.formatUnits(amount, 6)} USDC`);
                        appendLog(`  Description: ${description}`);
                      }
                    } catch (e) {
                      appendLog(`❌ Error: ${e.message}`);
                    }
                  }}
                  style={{ flexShrink: 0, minWidth: 100, background: '#7d5dff' }}
                >
                  🐛 Debug
                </button>
              </div>

              {managedInvoice && (
                <div className="invoice-details-box modern-card" style={{ marginTop: 20 }}>
                  <h4 className="card-title" style={{ marginBottom: 15 }}>
                    Management for <span className="invoice-id">#{managedInvoice.id}</span>
                  </h4>
                    
                  <div
                    className="status-badge"
                    style={{
                      backgroundColor: managedInvoice.issuer.toLowerCase() === wallet?.toLowerCase()
                          ? managedInvoice.paid ? 'rgba(251, 191, 36, 0.1)' : 'rgba(74, 222, 128, 0.1)'
                          : 'rgba(248, 113, 113, 0.1)',
                      color: managedInvoice.issuer.toLowerCase() === wallet?.toLowerCase()
                          ? managedInvoice.paid ? '#fbbf24' : '#4ade80'
                          : '#f87171',
                      fontWeight: 'bold',
                      padding: '6px 10px',
                      borderRadius: '4px',
                      marginBottom: '15px',
                      textAlign: 'center',
                      border: managedInvoice.issuer.toLowerCase() === wallet?.toLowerCase()
                          ? managedInvoice.paid ? '1px solid #fbbf24' : '1px solid #4ade80'
                          : '1px solid #f87171',
                    }}
                  >
                    {managedInvoice.issuer.toLowerCase() === wallet?.toLowerCase()
                        ? managedInvoice.paid ? 'PAID - NOT EDITABLE' : 'ISSUED BY YOU (EDITABLE)'
                        : 'NOT ISSUED BY YOU'}
                  </div>

                  <div style={{ display: 'flex', gap: 10, marginTop: 15 }}>
                    <button
                        className="action"
                        onClick={() => setEditMode(true)}
                        disabled={!wallet || managedInvoice.paid || managedInvoice.issuer.toLowerCase() !== wallet.toLowerCase() || editMode}
                    >
                        Edit Details
                    </button>
                    <button
                        className="primary"
                        style={{ backgroundColor: '#dc2626', background: 'linear-gradient(135deg, #dc2626, #f87171)'}}
                        onClick={handleDeleteInvoice}
                        disabled={deleting || !wallet || managedInvoice.paid || managedInvoice.issuer.toLowerCase() !== wallet.toLowerCase()}
                    >
                        {deleting ? 'Cancelling...' : 'Cancel Invoice'}
                    </button>
                  </div>

                  {editMode && managedInvoice && managedInvoice.issuer.toLowerCase() === wallet?.toLowerCase() && !managedInvoice.paid && (
                      <div style={{ marginTop: 25, paddingTop: 15, borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                          <h4 style={{ fontSize: 14, marginBottom: 10 }}>Edit Invoice Fields</h4>
                          
                          <label>New Invoice ID</label>
                          <input
                              value={editNewId}
                              onChange={(e) => setEditNewId(e.target.value)}
                              placeholder={managedInvoice.id}
                              disabled={editing}
                          />

                          <label>New Amount (USDC)</label>
                          <input
                              type="text"
                              value={editNewAmount}
                              onChange={(e) => {
                                    const v = e.target.value.replace(",", "."); 
                                    setEditNewAmount(v);
                              }}
                              placeholder={managedInvoice.amountFormatted}
                              disabled={editing}
                          />

                          <label>New Description</label>
                          <input
                              value={editNewDesc}
                              onChange={(e) => setEditNewDesc(e.target.value)}
                              placeholder={managedInvoice.description || "No description"}
                              disabled={editing}
                          />

                      <button
                        className="primary"
                        onClick={handleEditInvoice}
                        disabled={editing || !wallet || !editNewId.trim() || !editNewAmount.trim()}
                        style={{ width: '100%', marginTop: 10 }}
                      >
                        {editing ? 'Applying Changes...' : 'Save Changes'}
                      </button>
                      
                      <button
                        className="action"
                        onClick={() => setEditMode(false)}
                        disabled={editing}
                        style={{ width: '100%', marginTop: 8, background: '#262a50' }}
                      >
                        Cancel Edit
                      </button>
                  </div>
                  )}

                  <div style={{ marginTop: 25, paddingTop: 15, borderTop: '1px solid rgba(255, 255, 255, 0.1)' }}>
                    <h5 style={{ fontSize: 14, marginBottom: 10 }}>Current Details</h5>
                    <div className="detail-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 20px', fontSize: 13 }}>
                        <div className="detail-item"><div className="label">Amount</div><div className="value amount-value">{managedInvoice.amountFormatted} USDC</div></div>
                        <div className="detail-item"><div className="label">Status</div><div className="value">{managedInvoice.paid ? 'Paid' : 'Unpaid'}</div></div>
                        <div className="detail-item" style={{ gridColumn: 'span 2' }}><div className="label">Description</div><div className="value">{managedInvoice.description}</div></div>
                        <div className="detail-item" style={{ gridColumn: 'span 2' }}><div className="label">Issuer Address</div><div className="value address-value">{managedInvoice.issuer}</div></div>
                    </div>
                  </div>
                  
                </div>
              )}
            </section>
          </>
        );
      case "about":
        return (
          <>
            <section className="panel" style={{ gridColumn: 'span 2' }}>
              <div style={{ textAlign: 'center', marginBottom: 30 }}>
                <img 
                  src="https://i.ibb.co/jvnqfNKV/logopng.png" 
                  alt="Parcy Logo" 
                  style={{ maxWidth: 200, height: 'auto', marginBottom: 20 }}
                />
                <h2 style={{ fontSize: 28, fontWeight: 600, marginBottom: 10 }}>Parcy - On-Chain Invoicing System</h2>
                <p style={{ fontSize: 14, color: '#a0a0c0' }}>Built by Sercan0x</p>
              </div>

              <div style={{ maxWidth: 800, margin: '0 auto', lineHeight: 1.8, fontSize: 14 }}>
                <h3 style={{ fontSize: 18, marginBottom: 15, marginTop: 25 }}>📋 What is Parcy?</h3>
                <p style={{ marginBottom: 20, color: '#d4d4e8' }}>
                  Parcy is a decentralized invoicing platform built on the Arc Network blockchain. It enables businesses, freelancers, 
                  and service providers to create, manage, and receive payments for invoices using USDC cryptocurrency in a fully 
                  transparent and trustless manner.
                </p>

                <h3 style={{ fontSize: 18, marginBottom: 15, marginTop: 25 }}>🎯 Core Features</h3>
                <ul style={{ marginBottom: 20, paddingLeft: 20, color: '#d4d4e8' }}>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Create Invoices:</strong> Issue professional invoices with custom IDs, amounts, and descriptions directly on-chain
                  </li>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Pay with USDC:</strong> Accept payments in USDC stablecoin with automatic fee collection (1%)
                  </li>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Edit & Manage:</strong> Modify invoice details or cancel unpaid invoices before payment
                  </li>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Transaction Transparency:</strong> All invoices and payments are permanently recorded on the blockchain
                  </li>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Multi-Creator Support:</strong> Contract owner can authorize multiple invoice creators with custom prefixes
                  </li>
                </ul>

                <h3 style={{ fontSize: 18, marginBottom: 15, marginTop: 25 }}>💡 How It Works</h3>
                <div style={{ marginBottom: 20, color: '#d4d4e8' }}>
                  <p style={{ marginBottom: 10 }}>
                    <strong>For Invoice Issuers:</strong>
                  </p>
                  <ol style={{ paddingLeft: 20, marginBottom: 15 }}>
                    <li>Connect your wallet and ensure you have authorization to create invoices</li>
                    <li>Navigate to "Create Invoice" and enter the invoice details (ID, amount, description)</li>
                    <li>Submit the transaction to publish your invoice on-chain</li>
                    <li>Share the invoice ID with your client for payment</li>
                  </ol>

                  <p style={{ marginBottom: 10 }}>
                    <strong>For Invoice Payers:</strong>
                  </p>
                  <ol style={{ paddingLeft: 20 }}>
                    <li>Go to "Pay / Lookup" and enter the invoice ID</li>
                    <li>Review the invoice details (amount, issuer, description)</li>
                    <li>Approve USDC spending for the total amount (invoice + 1% fee)</li>
                    <li>Complete the payment transaction</li>
                  </ol>
                </div>

                <h3 style={{ fontSize: 18, marginBottom: 15, marginTop: 25 }}>🔐 Smart Contract Features</h3>
                <ul style={{ marginBottom: 20, paddingLeft: 20, color: '#d4d4e8' }}>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Authorization System:</strong> Only the contract owner or authorized creators can issue invoices
                  </li>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Prefix Control:</strong> Creators can be assigned specific prefixes to organize invoice IDs
                  </li>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Immutable Payments:</strong> Once paid, invoices cannot be modified or deleted
                  </li>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Fee Structure:</strong> Automatic 1% platform fee transferred to contract owner
                  </li>
                  <li style={{ marginBottom: 10 }}>
                    <strong>Event Logging:</strong> All actions emit blockchain events for complete auditability
                  </li>
                </ul>

                <h3 style={{ fontSize: 18, marginBottom: 15, marginTop: 25 }}>🚀 Technology Stack</h3>
                <ul style={{ marginBottom: 20, paddingLeft: 20, color: '#d4d4e8' }}>
                  <li style={{ marginBottom: 10 }}><strong>Blockchain:</strong> Arc Network Testnet</li>
                  <li style={{ marginBottom: 10 }}><strong>Smart Contract:</strong> Solidity ^0.8.20</li>
                  <li style={{ marginBottom: 10 }}><strong>Payment Token:</strong> USDC (Arc Network)</li>
                  <li style={{ marginBottom: 10 }}><strong>Frontend:</strong> React with Next.js</li>
                  <li style={{ marginBottom: 10 }}><strong>Web3 Library:</strong> ethers.js v6</li>
                </ul>

                <h3 style={{ fontSize: 18, marginBottom: 15, marginTop: 25 }}>🌐 Use Cases</h3>
                <ul style={{ marginBottom: 20, paddingLeft: 20, color: '#d4d4e8' }}>
                  <li style={{ marginBottom: 10 }}>Freelance service payments with transparent tracking</li>
                  <li style={{ marginBottom: 10 }}>B2B invoicing with cryptocurrency settlement</li>
                  <li style={{ marginBottom: 10 }}>Subscription-based services with recurring invoice creation</li>
                  <li style={{ marginBottom: 10 }}>Cross-border payments without traditional banking delays</li>
                  <li style={{ marginBottom: 10 }}>Micro-payments and gig economy transactions</li>
                </ul>

                <h3 style={{ fontSize: 18, marginBottom: 15, marginTop: 25 }}>⚠️ Important Notes</h3>
                <ul style={{ marginBottom: 20, paddingLeft: 20, color: '#d4d4e8' }}>
                  <li style={{ marginBottom: 10 }}>This application is currently deployed on Arc Network <strong>Testnet</strong></li>
                  <li style={{ marginBottom: 10 }}>All transactions require USDC approval before payment</li>
                  <li style={{ marginBottom: 10 }}>Invoice IDs must be unique and cannot be reused</li>
                  <li style={{ marginBottom: 10 }}>Paid invoices cannot be edited or deleted</li>
                  <li style={{ marginBottom: 10 }}>Always verify invoice details before making payments</li>
                </ul>

                <div style={{ 
                  marginTop: 40, 
                  padding: 20, 
                  background: 'rgba(79, 107, 255, 0.1)', 
                  border: '1px solid rgba(79, 107, 255, 0.3)', 
                  borderRadius: 12,
                  textAlign: 'center'
                }}>
                  <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 10, color: '#6b7bff' }}>
                    Developed by Sercan0x
                  </p>
                  <p style={{ fontSize: 13, color: '#a0a0c0' }}>
                    A decentralized solution for modern invoicing on Arc Network
                  </p>
                </div>
              </div>
            </section>
          </>
        );
      default:
        return null;
    }
  }, [currentPage, invoice, lookupId, managedInvoice, manageId, editMode, editNewId, editNewAmount, editNewDesc, newId, newAmount, newDesc, canCreate, creating, paying, approving, editing, deleting, wallet, decimals, lastTxHash, usdc, payArc]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div>
          <div className="logo">
            <div className="logo-badge"></div>
            <span>Parcy</span>
          </div>
        </div>

        <div>
          <div className="nav-title">Navigation</div>
          <div className="nav">
            <div 
              className={`nav-item ${currentPage === "pay" ? "active" : ""}`}
              onClick={() => setCurrentPage("pay")}
            >
              <span>💸 Pay / Lookup</span>
              {currentPage === "pay" && <span className="nav-dot"></span>}
            </div>
            <div 
              className={`nav-item ${currentPage === "create" ? "active" : ""}`}
              onClick={() => setCurrentPage("create")}
            >
              <span>➕ Create Invoice</span>
              {currentPage === "create" && <span className="nav-dot"></span>}
            </div>
            <div 
              className={`nav-item ${currentPage === "manage" ? "active" : ""}`}
              onClick={() => setCurrentPage("manage")}
            >
              <span>⚙️ Manage (Edit/Cancel)</span>
              {currentPage === "manage" && <span className="nav-dot"></span>}
            </div>
            <div 
              className={`nav-item ${currentPage === "about" ? "active" : ""}`}
              onClick={() => setCurrentPage("about")}
            >
              <span>ℹ️ About</span>
              {currentPage === "about" && <span className="nav-dot"></span>}
            </div>
          </div>
        </div>

        <div className="sidebar-footer">
          <div>Arc Testnet</div>
          <div className="sidebar-chip">
            <span>Economic OS</span>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: "#4ade80",
              }}
            ></span>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="main-header">
          <div className="title-block">
            <h1>On-chain Invoicing</h1>
            <p>Issue, manage and pay invoices on Arc using USDC.</p>
          </div>

          <div
            className={`wallet-pill ${wallet ? "" : "disconnected"}`}
            onClick={connectWallet}
          >
            <span className="dot"></span>
            <span className="label">
              {wallet ? "Connected" : "Connect Wallet"}
            </span>
            <span id="wallet-addr">{shortWallet}</span>
          </div>
        </div>

        <div className="grid">
          {renderContent}

          {currentPage !== "about" && (
            <section className="panel log-panel">
              <div className="log-title">
                <span>Activity Log</span>
                <span className="badge">Live</span>
              </div>
              <div id="log">{log}</div>

              <div className="network">
                Network: <span>Arc Testnet</span> · Token: <span>USDC</span>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

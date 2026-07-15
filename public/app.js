// ======================================
// TRANSACTOS
// app.js (Part 1)
// ======================================

const API = "http://localhost:3000";

let accounts = [];

const accountsContainer = document.getElementById("accountsContainer");
const ledgerFeed = document.getElementById("ledgerFeed");

const fromAccount = document.getElementById("fromAccount");
const toAccount = document.getElementById("toAccount");
console.log(fromAccount);
console.log(toAccount);

const refreshBtn = document.getElementById("refreshBtn");

const accountsCount = document.getElementById("accountsCount");
const transactionCount = document.getElementById("transactionCount");
const moneyProcessed = document.getElementById("moneyProcessed");
const duplicateCount = document.getElementById("duplicateCount");

// ======================================
// START APP
// ======================================

window.addEventListener("load", async () => {

    setTimeout(() => {

        document.getElementById("loading-screen").style.display = "none";

        document.getElementById("app").style.display = "block";

    },1800);

    await loadAccounts();

});

// ======================================
// LOAD ACCOUNTS
// ======================================

async function loadAccounts(){

    try{

        const res = await fetch(`${API}/accounts`);

        accounts = await res.json();

        renderAccounts();

        populateDropdowns();
        populateDepositWithdrawDropdowns();

        updateStats();

    }

    catch(err){

        toast("Cannot connect to backend","error");

        console.error(err);

    }

}

// ======================================
// ACCOUNT CARDS
// ======================================

function renderAccounts(){

    accountsContainer.innerHTML="";

    accounts.forEach(acc=>{

        const card=document.createElement("div");

        card.className="account-card";

        card.innerHTML=`

            <div class="account-avatar">

                ${acc.owner_name.charAt(0).toUpperCase()}

            </div>

            <div class="account-name">

                ${acc.owner_name}

            </div>

            <div class="account-balance">

                ₹${Number(acc.balance).toLocaleString()}

            </div>

            <div class="account-id">

                Wallet #${acc.account_id}

            </div>

        `;

        card.onclick=()=>loadHistory(acc.account_id);

        accountsContainer.appendChild(card);

    });

}

// ======================================
// DROPDOWNS
// ======================================

function populateDropdowns(){

    fromAccount.innerHTML="";

    toAccount.innerHTML="";

    accounts.forEach(acc=>{

        const option=document.createElement("option");

        option.value=acc.account_id;

        option.textContent=`${acc.owner_name} (₹${acc.balance})`;

        fromAccount.appendChild(option);

    });

    accounts.forEach(acc=>{

        const option=document.createElement("option");

        option.value=acc.account_id;

        option.textContent=`${acc.owner_name} (₹${acc.balance})`;

        toAccount.appendChild(option);

    });

}

// ======================================
// DEPOSIT / WITHDRAW
// Add this near populateDropdowns(), and call
// populateDepositWithdrawDropdowns() inside loadAccounts()
// right after populateDropdowns().
// ======================================

const depositAccount = document.getElementById("depositAccount");
const withdrawAccount = document.getElementById("withdrawAccount");
const depositForm = document.getElementById("depositForm");
const withdrawForm = document.getElementById("withdrawForm");

function populateDepositWithdrawDropdowns(){

    depositAccount.innerHTML = "";
    withdrawAccount.innerHTML = "";

    accounts.forEach(acc => {

        const opt1 = document.createElement("option");
        opt1.value = acc.account_id;
        opt1.textContent = `${acc.owner_name} (₹${acc.balance})`;
        depositAccount.appendChild(opt1);

        const opt2 = document.createElement("option");
        opt2.value = acc.account_id;
        opt2.textContent = `${acc.owner_name} (₹${acc.balance})`;
        withdrawAccount.appendChild(opt2);

    });

}

depositForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    const account_id = depositAccount.value;
    const amount = Number(document.getElementById("depositAmount").value);

    try{

        const res = await fetch(`${API}/deposit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                idempotency_key: generateKey(),
                account_id,
                amount
            })
        });

        const data = await res.json();

        if(!res.ok){
            toast(data.error || "Deposit failed", "error");
            return;
        }

        toast("Deposit successful");
        depositForm.reset();
        await loadAccounts();
        await loadHistory(account_id);

    } catch(err){
        console.error(err);
        toast("Server unavailable", "error");
    }

});

withdrawForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    const account_id = withdrawAccount.value;
    const amount = Number(document.getElementById("withdrawAmount").value);

    try{

        const res = await fetch(`${API}/withdraw`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                idempotency_key: generateKey(),
                account_id,
                amount
            })
        });

        const data = await res.json();

        if(!res.ok){
            toast(data.error || "Withdrawal failed", "error");
            return;
        }

        toast("Withdrawal successful");
        withdrawForm.reset();
        await loadAccounts();
        await loadHistory(account_id);

    } catch(err){
        console.error(err);
        toast("Server unavailable", "error");
    }

});

// ======================================
// STATS
// ======================================

function updateStats(){

    accountsCount.textContent=accounts.length;

    let total=0;

    accounts.forEach(a=>{

        total+=Number(a.balance);

    });

    moneyProcessed.textContent="₹"+total.toLocaleString();

}

// ======================================
// HISTORY
// ======================================

async function loadHistory(id){

    const res=await fetch(`${API}/accounts/${id}/history`);

    const data=await res.json();

    ledgerFeed.innerHTML="";

    transactionCount.textContent=data.length;

    data.forEach(tx=>{

        const item=document.createElement("div");

        item.className=`ledger-item ${
            tx.entry_type==="credit"
            ?"ledger-credit"
            :"ledger-debit"
        }`;

        item.innerHTML=`

            <div class="ledger-header">

                <div class="ledger-title">

                    ${tx.entry_type.toUpperCase()}

                </div>

                <div class="ledger-time">

                    ${new Date(tx.created_at).toLocaleString()}

                </div>

            </div>

            <div class="ledger-amount ${tx.entry_type==="credit"?"credit":"debit"}">

                ${tx.entry_type==="credit"?"+":"-"} ₹${tx.entry_amount}

            </div>

        `;

        ledgerFeed.appendChild(item);

    });

}

// ======================================
// RANDOM KEY
// ======================================

function generateKey(){

    return crypto.randomUUID();

}

// ======================================
// REFRESH
// ======================================

refreshBtn.onclick=async()=>{

    await loadAccounts();

    toast("Accounts refreshed");

};

// ======================================
// TRANSFER
// ======================================

const transferForm = document.getElementById("transferForm");

const successModal = document.getElementById("successModal");
const successMessage = document.getElementById("successMessage");
const closeModal = document.getElementById("closeModal");

transferForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    // FIX: account IDs are UUIDs (text like "a5bb97d5-...."), NOT numbers.
    // parseInt() was turning them into NaN -> null, which is why the
    // backend kept rejecting every request as "missing required field".
    // Just keep them as plain strings - no parseInt, no Number().
    const sender = document.getElementById("fromAccount").value;

    const receiver = document.getElementById("toAccount").value;

    console.log(sender, receiver);

    const amount = Number(document.getElementById("amount").value);

    let reference = document.getElementById("reference").value.trim();

    if(sender === receiver){

        toast("Sender and receiver cannot be same.","error");

        return;

    }

    if(!reference){

        reference = generateKey();

    }

    try{

        const res = await fetch(`${API}/transfer`,{

            method:"POST",

            headers:{
                "Content-Type":"application/json"
            },

            body:JSON.stringify({

                idempotency_key:reference,

                from_account_id:sender,

                to_account_id:receiver,

                amount

            })

        });

        const data = await res.json();

        if(!res.ok){

            toast(data.error || "Transfer failed","error");

            return;

        }

        if(data.message.includes("Already")){

            duplicateCount.textContent =
                Number(duplicateCount.textContent)+1;

            toast("Duplicate request ignored.","warning");

            return;

        }

        successMessage.innerHTML = `

            ₹${amount.toLocaleString()}

            transferred successfully.

            <br><br>

            Transaction ID

            <br>

            <b>${data.transaction.id}</b>

        `;

        successModal.style.display="flex";

        transferForm.reset();

        await loadAccounts();

        await loadHistory(sender);

        toast("Transfer successful");

    }

    catch(err){

        console.error(err);

        toast("Server unavailable","error");

    }

});

closeModal.onclick=()=>{

    successModal.style.display="none";

};

window.onclick=(e)=>{

    if(e.target===successModal){

        successModal.style.display="none";

    }

};

// ======================================
// TOAST
// ======================================

function toast(message,type="success"){

    const container=document.getElementById("toastContainer");

    const div=document.createElement("div");

    div.className=`toast ${type}`;

    div.innerHTML=`

        <strong>${type.toUpperCase()}</strong>

        <br>

        ${message}

    `;

    container.appendChild(div);

    setTimeout(()=>{

        div.remove();

    },3500);

}

// ======================================
// STRESS TEST
// ======================================

const stressBtn=document.getElementById("stressBtn");

const progressBar=document.getElementById("progressBar");

const stressConsole=document.getElementById("stressConsole");

stressBtn.onclick=async()=>{

    stressConsole.innerHTML="";

    progressBar.style.width="0%";

    if(accounts.length<2){

        toast("Need at least 2 accounts","error");

        return;

    }

    const sender=accounts[0].account_id;

    const receiver=accounts[1].account_id;

    const promises=[];

    for(let i=0;i<20;i++){

        promises.push(runStressTransfer(sender,receiver,i));

    }

    await Promise.all(promises);

    progressBar.style.width="100%";

    toast("Stress test completed");

    await loadAccounts();

    await loadHistory(sender);

};

async function runStressTransfer(sender,receiver,index){

    const key=generateKey();

    try{

        const res=await fetch(`${API}/transfer`,{

            method:"POST",

            headers:{
                "Content-Type":"application/json"
            },

            body:JSON.stringify({

                idempotency_key:key,

                from_account_id:sender,

                to_account_id:receiver,

                amount:1

            })

        });

        const data=await res.json();

        const line=document.createElement("div");

        line.className="console-line";

        if(res.ok){

            line.classList.add("console-success");

            line.innerHTML=`✔ Request ${index+1} completed`;

        }

        else{

            line.classList.add("console-error");

            line.innerHTML=`✖ Request ${index+1} failed`;

        }

        stressConsole.appendChild(line);

        progressBar.style.width=`${((index+1)/20)*100}%`;

    }

    catch{

        const line=document.createElement("div");

        line.className="console-line console-error";

        line.innerHTML=`✖ Network Error`;

        stressConsole.appendChild(line);

    }

}

// ======================================
// KEYBOARD SHORTCUT
// ======================================

document.addEventListener("keydown",(e)=>{

    if(e.ctrlKey && e.key==="r"){

        e.preventDefault();

        loadAccounts();

        toast("Dashboard refreshed");

    }

});

// ======================================
// AUTO REFRESH
// ======================================

setInterval(()=>{

    loadAccounts();

},30000);
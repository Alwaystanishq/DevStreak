const vscode = require("vscode");

let statusBarItem;
let displayTimer;
let autoSaveTimer;
let startTime = 0;
let currentDate = "";
let data = {};

let activityPanel = null;
function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
  );
  statusBarItem.command = "devstreak.openActivity";
  statusBarItem.show();
  data = context.globalState.get("devstreakData", {});
  currentDate = getToday();
  ensureTodayEntry();
  startTime = Date.now();

  // DISPLAY TIMER
  displayTimer = setInterval(() => {
    checkDateChange(context);
    const sessionSeconds = Math.floor((Date.now() - startTime) / 1000);
    const totalTime = data[currentDate].time + sessionSeconds;
    statusBarItem.text = `⏱ ${formatTime(totalTime)}`;
    statusBarItem.tooltip = `DevStreak — Today
Time : ${formatTime(totalTime)}
Letters : ${data[currentDate].letters}
Files : ${data[currentDate].files.length}`;
  }, 1000);

  // AUTO SAVE
  autoSaveTimer = setInterval(() => {
    checkDateChange(context);
    const sessionSeconds = Math.floor((Date.now() - startTime) / 1000);
    data[currentDate].time += sessionSeconds;
    startTime = Date.now();
    context.globalState.update("devstreakData", data);
  }, 5000);

  // FILE + LETTER TRACK
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    const doc = event.document;
    if (doc.uri.scheme !== "file") return;
    const fileName = doc.fileName.split("\\").pop().split("/").pop();
    if (!data[currentDate].files.includes(fileName)) {
      data[currentDate].files.push(fileName);
    }
    event.contentChanges.forEach((change) => {
      data[currentDate].letters += change.text.length;
    });
    context.globalState.update("devstreakData", data);
  });
  context.subscriptions.push(changeListener);

  // OPEN ACTIVITY TAB
  const openActivityCommand = vscode.commands.registerCommand(
    "devstreak.openActivity",
    () => {
      if (activityPanel) {
        activityPanel.reveal(vscode.ViewColumn.One);
        return;
      }
      activityPanel = vscode.window.createWebviewPanel(
        "devstreakActivity",
        "DevStreak Activity",
        vscode.ViewColumn.One,
        { enableScripts: true },
      );
      activityPanel.webview.html = getHeatmapHTML(data);
      activityPanel.onDidDispose(() => (activityPanel = null));
    },
  );
  context.subscriptions.push(openActivityCommand);

  // SAVE ON CLOSE
  context.subscriptions.push({
    dispose: () => {
      const sessionSeconds = Math.floor((Date.now() - startTime) / 1000);
      data[currentDate].time += sessionSeconds;
      context.globalState.update("devstreakData", data);
      clearInterval(displayTimer);
      clearInterval(autoSaveTimer);
    },
  });
}

function checkDateChange(context) {
  const todayNow = getToday();
  if (todayNow !== currentDate) {
    const sessionSeconds = Math.floor((Date.now() - startTime) / 1000);
    data[currentDate].time += sessionSeconds;
    currentDate = todayNow;
    ensureTodayEntry();
    startTime = Date.now();
    context.globalState.update("devstreakData", data);
  }
}

// Ensure Day Exists
function ensureTodayEntry() {
  if (!data[currentDate]) {
    data[currentDate] = {
      time: 0,
      letters: 0,
      files: [],
    };
  }
}

// DATE
function getToday() {
  return new Date().toISOString().split("T")[0];
}

// TIME FORMAT
function formatTime(sec) {
  let h = Math.floor(sec / 3600);
  let m = Math.floor((sec % 3600) / 60);
  let s = sec % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function pad(n) {
  return n.toString().padStart(2, "0");
}

function getHeatmapHTML(data) {
  const now = new Date();
  const today = getToday();
  let monthsHTML = "";
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth();
    const monthName = d.toLocaleString(undefined, {
      month: "long",
      year: "numeric",
    });
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    let daysHTML = "";
    for (let day = 1; day <= daysInMonth; day++) {
      const dateKey = `${year}-${pad(month + 1)}-${pad(day)}`;
      const active = data[dateKey] ? "active" : "";
      const todayClass = dateKey === today ? "today" : "";
      daysHTML += `

<div class="day ${active} ${todayClass}"
onclick="showDetails('${dateKey}')">

${day}

</div>

`;
    }

    monthsHTML += `

<h2>${monthName}</h2>

<div class="monthGrid">

${daysHTML}

</div>

`;
  }

  return `

<html>

<head>

<style>

body{

margin:0;

display:flex;

font-family:Segoe UI,sans-serif;

background:
var(--vscode-editor-background);

color:
var(--vscode-editor-foreground);

height:100vh;

}

.calendar{

width:60%;

overflow-y:auto;

padding:25px;

}

.monthGrid{

display:grid;

grid-template-columns:
repeat(7,1fr);

gap:10px;

margin-bottom:35px;

}

.day{

border:1px solid
var(--vscode-panel-border);

border-radius:8px;

height:70px;

display:flex;

align-items:center;

justify-content:center;

cursor:pointer;

transition:.2s;

}

.day:hover{

transform:translateY(-2px);

background:
var(--vscode-list-hoverBackground);

}

/* ACTIVE DAY */

.day.active{

background:#4caf50;

color:white;

font-weight:bold;

}

/* TODAY */

.day.today{

outline:2px solid #ff9800;

}

.details{

width:40%;

border-left:1px solid
var(--vscode-panel-border);

padding:25px;

overflow-y:auto;

line-height:1.6;

}

</style>

</head>

<body>

<div class="calendar">

${monthsHTML}

</div>

<div
class="details"
id="details">

Select a day

</div>

<script>

const data =
${JSON.stringify(data)};

function showDetails(date){

const d=data[date];

const el=
document.getElementById("details");

const dateObj=new Date(date);

const fullDate=
dateObj.toLocaleDateString(
undefined,
{
weekday:"long",
day:"numeric",
month:"long",
year:"numeric"
});

if(!d){

el.innerHTML=
"<h2>"+fullDate+"</h2>"+
"<p>No activity recorded.</p>";

return;

}

let filesHTML=
d.files.length
?d.files.join("<br>")
:"None";

el.innerHTML=

"<h2>"+fullDate+"</h2>"+

"<hr>"+

"<p>⏱ Time : "+
formatTime(d.time)+
"</p>"+

"<p>⌨ Letters : "+
d.letters+
"</p>"+

"<p>📁 Files :</p>"+

"<div>"+
filesHTML+
"</div>";

}

function formatTime(sec){

let h=Math.floor(sec/3600);

let m=Math.floor(
(sec%3600)/60);

let s=sec%60;

return pad(h)+":"+
pad(m)+":"+
pad(s);

}

function pad(n){

return n.toString()
.padStart(2,"0");

}

</script>

</body>

</html>

`;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};


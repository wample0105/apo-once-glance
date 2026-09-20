const params = new URLSearchParams(location.search);
const text = decodeURIComponent(params.get("text") || "");
const level = decodeURIComponent(params.get("level") || "success");
document.getElementById("text").textContent = text;
document.getElementById("dot").className = "dot " + level;

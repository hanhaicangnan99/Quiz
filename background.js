/* 后台脚本：点击扩展图标在新标签页打开答题 App；首次侧载后自动打开一次。 */
chrome.action.onClicked.addListener(function () {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

chrome.runtime.onInstalled.addListener(function (details) {
  if (details && details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
  }
});

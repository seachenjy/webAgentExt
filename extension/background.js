chrome.runtime.onInstalled.addListener(() => {
  console.log('Web Agent IR Tester installed');
  
  // 设置点击图标时打开侧边栏
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
});

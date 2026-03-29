export function showDialog(title, inputType = false, defaultValue = "") {
  return new Promise((resolve) => {
    const dialog = document.getElementById("custom-dialog");
    const titleEl = document.getElementById("dialog-title");
    const bodyEl = document.getElementById("dialog-body");
    const dateInput = document.getElementById("dialog-date-input");
    const textInput = document.getElementById("dialog-text-input");
    const confirmBtn = document.getElementById("dialog-confirm");
    const cancelBtn = document.getElementById("dialog-cancel");

    if (inputType === "html") {
      titleEl.innerText = "Edit Shift";
      dateInput.style.display = "none";
      textInput.style.display = "none";
      // Insert custom HTML before the standard inputs
      let customEl = bodyEl.querySelector(".dialog-custom");
      if (customEl) customEl.remove();
      customEl = document.createElement("div");
      customEl.className = "dialog-custom";
      customEl.innerHTML = title;
      bodyEl.insertBefore(customEl, dateInput);
    } else {
      const customEl = bodyEl.querySelector(".dialog-custom");
      if (customEl) customEl.remove();
      titleEl.innerText = title;
      dateInput.style.display = inputType === "date" ? "block" : "none";
      textInput.style.display = inputType === "text" ? "block" : "none";
    }

    if (inputType === "date")
      dateInput.value = new Date().toISOString().split("T")[0];
    if (inputType === "text") textInput.value = defaultValue;

    dialog.classList.remove("hidden");

    const close = (result) => {
      dialog.classList.add("hidden");
      const customEl = bodyEl.querySelector(".dialog-custom");
      if (customEl) customEl.remove();
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      resolve(result);
    };

    confirmBtn.onclick = () => {
      if (inputType === "date") close(dateInput.value);
      else if (inputType === "text") close(textInput.value);
      else close(true);
    };
    cancelBtn.onclick = () => close(false);
  });
}

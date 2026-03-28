export function showDialog(title, inputType = false, defaultValue = "") {
  return new Promise((resolve) => {
    const dialog = document.getElementById("custom-dialog");
    const titleEl = document.getElementById("dialog-title");
    const dateInput = document.getElementById("dialog-date-input");
    const textInput = document.getElementById("dialog-text-input");
    const confirmBtn = document.getElementById("dialog-confirm");
    const cancelBtn = document.getElementById("dialog-cancel");

    titleEl.innerText = title;
    dateInput.style.display = inputType === "date" ? "block" : "none";
    textInput.style.display = inputType === "text" ? "block" : "none";

    if (inputType === "date")
      dateInput.value = new Date().toISOString().split("T")[0];
    if (inputType === "text") textInput.value = defaultValue;

    dialog.classList.remove("hidden");

    const close = (result) => {
      dialog.classList.add("hidden");
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

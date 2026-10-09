/* ================================================================
   INFO POPUPS (reusable tooltip controller)
   ----------------------------------------------------------------
   Works with this markup:

     <div class="infoWrap">
       <button class="infoIcon" type="button"
               aria-label="..." aria-expanded="false">
         <i class="fas fa-info-circle"></i>
       </button>
       <div class="infoPopup" role="tooltip">
         Your tooltip text here
       </div>
     </div>

   Features:
     - Click the icon to toggle its popup
     - Only one popup open at a time
     - Click outside closes all
     - Escape key closes all
     - Keeps aria-expanded in sync
    
     Remember to include the info.js and info.css ofc hehe
   ================================================================ */

document.addEventListener("DOMContentLoaded", () => {
  const infoIcons = document.querySelectorAll(".infoIcon");

  function closeAllPopups(except = null) {
    document.querySelectorAll(".infoPopup.show").forEach((popup) => {
      if (popup === except) return;
      popup.classList.remove("show");
      const btn = popup.parentElement?.querySelector(".infoIcon");
      btn?.setAttribute("aria-expanded", "false");
    });
  }

  infoIcons.forEach((icon) => {
    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      const popup = icon.parentElement?.querySelector(".infoPopup");
      if (!popup) return;

      const isOpen = popup.classList.contains("show");
      closeAllPopups();
      if (!isOpen) {
        popup.classList.add("show");
        icon.setAttribute("aria-expanded", "true");
      }
    });
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".infoWrap")) closeAllPopups();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllPopups();
  });
});

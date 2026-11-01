document.addEventListener("DOMContentLoaded", () => {
    const infoIcons = document.querySelectorAll(".infoIcon");

    // Close every open popup except the one passed in
    // Also resets the aria-expanded state on the matching icon
    function closeAllPopups(except = null) {
        document.querySelectorAll(".infoPopup.show").forEach((popup) => {
            if (popup === except) return;
            popup.classList.remove("show");
            const btn = popup.parentElement?.querySelector(".infoIcon");
            btn?.setAttribute("aria-expanded", "false");
        });
    }

    // Toggle the popup for the clicked icon
    // Any other open popup is closed first
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

    // Clicks outside any .infoWrap close all popups
    document.addEventListener("click", (e) => {
        if (!e.target.closest(".infoWrap")) closeAllPopups();
    });

    // Escape key closes all popups
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeAllPopups();
    });
});
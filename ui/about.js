export async function renderAbout(container, sidebar) {
  try {
    const response = await fetch("ui/html/about.html"); // path to your HTML file
    if (!response.ok) throw new Error("Failed to load About page");

    const html = await response.text();
    container.innerHTML = html;

    const sidebarResponse = await fetch("ui/html/about-sidebar.html");
    if (sidebarResponse.ok) {
      const sidebarHtml = await sidebarResponse.text();
      sidebar.innerHTML = sidebarHtml;
    }

  } catch (err) {
    container.innerHTML = `<p>Error loading About page: ${err.message}</p>`;
    console.error(err);
  }
}

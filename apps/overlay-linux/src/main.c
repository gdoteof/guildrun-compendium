/**
 * Guildrun Overlay (Linux) — the Belly panel, floating over the game.
 *
 * The Linux half of apps/overlay-macos, and the same idea: this target is a
 * WINDOW and nothing else. Everything it displays is the companion's own
 * /belly?overlay=1 page in a WebKitGTK view, so the belly logic, the layout,
 * the stat icons and the live SSE stream have exactly one implementation.
 *
 * Why it exists, in Linux terms: Wayland deliberately denies clients the two
 * things a HUD needs — setting themselves always-on-top, and placing
 * themselves. wlr-layer-shell is the escape hatch, but GNOME/Mutter does not
 * implement it, so on the most common gaming desktop there is no Wayland
 * answer at all. X11 has had one since 1997.
 *
 * So this forces the GDK X11 backend and runs as an X11 client. Under a
 * Wayland session that means XWayland, which is present everywhere and is
 * where the game itself lands anyway (Proton is XWayland; Unity's Linux player
 * defaults to X11). One code path, both session types:
 *
 *   _NET_WM_STATE_ABOVE          keep-above, the WM stacks us over normal windows
 *   _NET_WM_STATE_STICKY         present on every workspace
 *   accept-focus = FALSE         never takes focus or keystrokes from the game
 *   _NET_WM_WINDOW_TYPE_UTILITY  a tool window, not a task
 *   input shape (X Shape ext)    optional click-through
 *   RGBA visual + transparent    the game shows through every unpainted pixel
 *   web view background alpha 0
 *
 * No injection, no game files read or written, no X input grabs, no screen
 * capture. It renders a localhost page. The game is not aware it exists.
 */

#include <gtk/gtk.h>
#include <gdk/gdkx.h>
#include <webkit2/webkit2.h>

#include <glib-unix.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/*
 * Identical to DRAG_SCRIPT in apps/overlay-macos/Sources/GuildrunOverlay/main.swift
 * — WebKitGTK and WKWebView expose the same window.webkit.messageHandlers API,
 * so the page-side contract is literally the same text on both platforms. Keep
 * them in step.
 *
 * A HUD has no title bar to grab, so the page reports the start of a drag and
 * the window manager moves the window. Only a left press on non-interactive
 * content is claimed, which leaves scrolling, hover and links working — a
 * transparent catcher view over the web view would have swallowed all three.
 */
static const char *DRAG_SCRIPT =
    "document.addEventListener('mousedown', (e) => {\n"
    "  if (e.button !== 0) return;\n"
    "  if (e.target.closest('a, button, input, select, textarea')) return;\n"
    "  e.preventDefault();\n"
    "  window.webkit.messageHandlers.drag.postMessage({});\n"
    "});\n"
    "document.documentElement.style.cursor = 'grab';\n";

#define DEFAULT_PORT 4646
#define RETRY_SECONDS 3
#define GEOMETRY_SAVE_DELAY_MS 800

typedef struct {
    GtkWindow *window;
    WebKitWebView *view;
    char *url;
    char *geometry_path;

    gboolean click_through;
    gboolean scrim;
    int opacity_percent;

    GtkStatusIcon *tray;
    gboolean tray_embedded;

    /* the last button press seen on the view, and where the window was when it
     * happened — a drag moves the window by the delta from these */
    gint drag_x_root;
    gint drag_y_root;
    gint drag_win_x;
    gint drag_win_y;
    gboolean dragging;

    guint retry_source;
    guint geometry_source;
} Overlay;

/* SIGUSR1 needs a way back to the instance; there is exactly one. */
static Overlay *g_overlay = NULL;

/* ------------------------------------------------------------------ config */

/** Same directory the companion itself uses (see apps/companion/src/paths.ts). */
static char *config_dir(void)
{
    const char *xdg = g_getenv("XDG_CONFIG_HOME");
    return xdg && *xdg ? g_build_filename(xdg, "guildrun-companion", NULL)
                       : g_build_filename(g_get_home_dir(), ".config",
                                          "guildrun-companion", NULL);
}

/** A HUD has no title bar, so where you put it is worth remembering. */
static void geometry_load(Overlay *o, int *x, int *y, int *w, int *h)
{
    char *text = NULL;
    if (!g_file_get_contents(o->geometry_path, &text, NULL, NULL)) return;
    int fx, fy, fw, fh;
    if (sscanf(text, "%d %d %d %d", &fx, &fy, &fw, &fh) == 4 && fw > 0 && fh > 0) {
        *x = fx; *y = fy; *w = fw; *h = fh;
    }
    g_free(text);
}

static gboolean geometry_save(gpointer data)
{
    Overlay *o = data;
    int x, y, w, h;
    gtk_window_get_position(o->window, &x, &y);
    gtk_window_get_size(o->window, &w, &h);

    char *text = g_strdup_printf("%d %d %d %d\n", x, y, w, h);
    char *dir = g_path_get_dirname(o->geometry_path);
    g_mkdir_with_parents(dir, 0755);
    g_file_set_contents(o->geometry_path, text, -1, NULL);
    g_free(dir);
    g_free(text);

    o->geometry_source = 0;
    return G_SOURCE_REMOVE;
}

/* The WM drives the move, so configure-event is the only notification there
 * is — and it fires continuously during one. Coalesce into a single write. */
static gboolean on_configure(GtkWidget *w, GdkEventConfigure *e, gpointer data)
{
    (void)w; (void)e;
    Overlay *o = data;
    if (o->geometry_source) g_source_remove(o->geometry_source);
    o->geometry_source = g_timeout_add(GEOMETRY_SAVE_DELAY_MS, geometry_save, o);
    return FALSE;
}

/* ------------------------------------------------------------------ drawing */

/**
 * Clear to fully transparent before the web view draws.
 *
 * An app-paintable RGBA window starts with undefined contents, so without this
 * the first frame can show whatever was in the buffer. CAIRO_OPERATOR_SOURCE
 * overwrites rather than blends, so the region really is alpha 0 and the game
 * shows through every pixel the page doesn't paint.
 */
static gboolean on_draw(GtkWidget *w, cairo_t *cr, gpointer data)
{
    (void)w; (void)data;
    cairo_save(cr);
    cairo_set_operator(cr, CAIRO_OPERATOR_SOURCE);
    cairo_set_source_rgba(cr, 0, 0, 0, 0);
    cairo_paint(cr);
    cairo_restore(cr);
    return FALSE; /* let the web view draw on top */
}

/* ------------------------------------------------------------------ loading */

static gboolean reload_now(gpointer data)
{
    Overlay *o = data;
    o->retry_source = 0;
    webkit_web_view_load_uri(o->view, o->url);
    return G_SOURCE_REMOVE;
}

/** The companion may not be up yet (or may be restarting) — keep trying
 *  quietly rather than sitting on an error page. */
static gboolean on_load_failed(WebKitWebView *view, WebKitLoadEvent ev,
                               gchar *uri, GError *err, gpointer data)
{
    (void)view; (void)ev; (void)uri; (void)err;
    Overlay *o = data;
    if (!o->retry_source)
        o->retry_source = g_timeout_add_seconds(RETRY_SECONDS, reload_now, o);
    return TRUE; /* suppress WebKit's error page; we're retrying */
}

/* ----------------------------------------------------------------- toggles */

/**
 * Click-through: an empty X input shape means the window takes no pointer
 * input at all, so clicks and drags land on the game underneath as if it
 * weren't there. The analogue of NSWindow.ignoresMouseEvents.
 *
 * It is a ONE-WAY DOOR from the overlay's own point of view — once input is
 * off, there is nothing left to right-click. So arming it always leaves two
 * ways back (the tray icon and SIGUSR1) and says so on the page as it happens,
 * because being told afterwards is no use.
 */
static void apply_click_through(Overlay *o, gboolean announce)
{
    GtkWidget *w = GTK_WIDGET(o->window);
    if (o->click_through) {
        cairo_region_t *empty = cairo_region_create();
        gtk_widget_input_shape_combine_region(w, empty);
        cairo_region_destroy(empty);
    } else {
        gtk_widget_input_shape_combine_region(w, NULL);
    }
    g_print("click-through %s\n", o->click_through ? "ON" : "OFF");
    fflush(stdout); /* long-lived process: stdout to a pipe is block-buffered */

    if (announce && o->click_through) {
        char *js = g_strdup_printf(
            "(() => { let t = document.getElementById('ct-note');"
            " if (!t) { t = document.createElement('div'); t.id = 'ct-note';"
            "   t.style.cssText = 'position:fixed;inset:auto 6px 6px 6px;padding:4px 6px;"
            "border-radius:6px;background:rgba(0,0,0,.75);color:#fff;font-size:11px;"
            "line-height:1.35;text-align:center';"
            "   document.body.appendChild(t); }"
            " t.textContent = 'Clicks now pass through. %s to get it back.';"
            " clearTimeout(window.__ctNote);"
            " window.__ctNote = setTimeout(() => t.remove(), 6000); })()",
            o->tray_embedded ? "Click the tray icon"
                             : "Run: kill -USR1 $(pgrep -f guildrun-overlay)");
        webkit_web_view_evaluate_javascript(o->view, js, -1, NULL, NULL, NULL, NULL, NULL);
        g_free(js);
    }
}

static void toggle_click_through(Overlay *o)
{
    o->click_through = !o->click_through;
    apply_click_through(o, TRUE);
}

/** Pure HUD is unreadable over some art; this dims what's behind the text.
 *  The page owns the styling, so it's one class toggle away. */
static void toggle_scrim(Overlay *o)
{
    o->scrim = !o->scrim;
    webkit_web_view_evaluate_javascript(
        o->view, "document.body.classList.toggle('scrim')", -1,
        NULL, NULL, NULL, NULL, NULL);
}

static void on_menu_hide(GtkMenuItem *i, gpointer d)
{ (void)i; gtk_widget_hide(GTK_WIDGET(((Overlay *)d)->window)); }

static void on_menu_show(GtkMenuItem *i, gpointer d)
{ (void)i; gtk_window_present(((Overlay *)d)->window); }

static void on_menu_click_through(GtkMenuItem *i, gpointer d)
{ (void)i; toggle_click_through(d); }

static void on_menu_scrim(GtkMenuItem *i, gpointer d)
{ (void)i; toggle_scrim(d); }

static void on_menu_reload(GtkMenuItem *i, gpointer d)
{ (void)i; reload_now(d); }

static void on_menu_quit(GtkMenuItem *i, gpointer d)
{ (void)i; (void)d; gtk_main_quit(); }

static void on_menu_opacity(GtkMenuItem *item, gpointer d)
{
    Overlay *o = d;
    if (!gtk_check_menu_item_get_active(GTK_CHECK_MENU_ITEM(item))) return;
    int percent = GPOINTER_TO_INT(g_object_get_data(G_OBJECT(item), "percent"));
    o->opacity_percent = percent;
    gtk_widget_set_opacity(GTK_WIDGET(o->window), percent / 100.0);
}

static GtkWidget *menu_item(GtkWidget *menu, const char *label,
                            GCallback cb, Overlay *o)
{
    GtkWidget *item = gtk_menu_item_new_with_label(label);
    g_signal_connect(item, "activate", cb, o);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), item);
    return item;
}

/** A toggle whose state is the checkbox, not the wording. Labels here say what
 *  the thing DOES, not what it currently is — "Click-through: off" reads as an
 *  instruction and gets clicked by people who want it off. */
static GtkWidget *check_item(GtkWidget *menu, const char *label, gboolean active,
                             GCallback cb, Overlay *o)
{
    GtkWidget *item = gtk_check_menu_item_new_with_label(label);
    gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(item), active);
    g_signal_connect(item, "toggled", cb, o);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), item);
    return item;
}

/** Built fresh each time so it always reflects the current state. Shown from
 *  both a right-click on the overlay and the tray icon. */
static GtkWidget *build_menu(Overlay *o)
{
    GtkWidget *menu = gtk_menu_new();

    if (gtk_widget_get_visible(GTK_WIDGET(o->window)))
        menu_item(menu, "Hide overlay", G_CALLBACK(on_menu_hide), o);
    else
        menu_item(menu, "Show overlay", G_CALLBACK(on_menu_show), o);

    check_item(menu, "Pass clicks through to the game", o->click_through,
               G_CALLBACK(on_menu_click_through), o);
    check_item(menu, "Dim backdrop", o->scrim, G_CALLBACK(on_menu_scrim), o);
    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());

    const int opacities[] = { 100, 85, 70, 55 };
    GSList *group = NULL;
    for (unsigned i = 0; i < G_N_ELEMENTS(opacities); i++) {
        char label[32];
        g_snprintf(label, sizeof label, "Opacity %d%%", opacities[i]);
        GtkWidget *item = gtk_radio_menu_item_new_with_label(group, label);
        group = gtk_radio_menu_item_get_group(GTK_RADIO_MENU_ITEM(item));
        g_object_set_data(G_OBJECT(item), "percent", GINT_TO_POINTER(opacities[i]));
        gtk_check_menu_item_set_active(GTK_CHECK_MENU_ITEM(item),
                                       o->opacity_percent == opacities[i]);
        g_signal_connect(item, "toggled", G_CALLBACK(on_menu_opacity), o);
        gtk_menu_shell_append(GTK_MENU_SHELL(menu), item);
    }

    gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());
    menu_item(menu, "Reload", G_CALLBACK(on_menu_reload), o);
    menu_item(menu, "Quit", G_CALLBACK(on_menu_quit), o);

    gtk_widget_show_all(menu);
    return menu;
}

static void popup_menu(Overlay *o, GdkEvent *event)
{
    gtk_menu_popup_at_pointer(GTK_MENU(build_menu(o)), event);
}

/* --------------------------------------------------------------- tray icon */

/*
 * The macOS target hangs its menu off an NSStatusItem. The equivalent here is a
 * tray icon — and it is not a nicety: it is the only way back once clicks are
 * passing through, since by then the overlay itself cannot be clicked.
 *
 * GtkStatusIcon is deprecated in GTK3 and has no GTK4 successor, but it is what
 * still works across the desktops this has to run on without dragging in
 * libayatana-appindicator as a build dependency. GNOME shows it through the
 * AppIndicator extension (default on Ubuntu); KDE, XFCE, Cinnamon and MATE have
 * a tray natively. Where nothing hosts it, gtk_status_icon_is_embedded() says
 * so at startup and SIGUSR1 remains the way back.
 */
G_GNUC_BEGIN_IGNORE_DEPRECATIONS

static void on_tray_activate(GtkStatusIcon *icon, gpointer d)
{
    (void)icon;
    /* Left click is the panic button: the reason people come looking for this
     * icon is that clicks are going through and they want them back. */
    toggle_click_through(d);
}

static void on_tray_popup(GtkStatusIcon *icon, guint button, guint time, gpointer d)
{
    gtk_menu_popup(GTK_MENU(build_menu(d)), NULL, NULL,
                   gtk_status_icon_position_menu, icon, button, time);
}

static void tray_init(Overlay *o)
{
    /* a themed name, so no icon file has to ship with a single-binary tool */
    o->tray = gtk_status_icon_new_from_icon_name("applications-games-symbolic");
    gtk_status_icon_set_title(o->tray, "Niklas' Belly");
    gtk_status_icon_set_tooltip_text(
        o->tray, "Niklas' Belly — click to toggle passing clicks through");
    gtk_status_icon_set_visible(o->tray, TRUE);
    g_signal_connect(o->tray, "activate", G_CALLBACK(on_tray_activate), o);
    g_signal_connect(o->tray, "popup-menu", G_CALLBACK(on_tray_popup), o);
}

/** Asked a moment after startup: embedding is asynchronous, and a false answer
 *  right away means nothing. */
static gboolean tray_check(gpointer data)
{
    Overlay *o = data;
    o->tray_embedded = o->tray && gtk_status_icon_is_embedded(o->tray);
    if (!o->tray_embedded)
        g_print("  tray    no host for a tray icon on this desktop —\n"
                "          kill -USR1 %d is the way back from click-through\n",
                (int)getpid());
    else
        g_print("  tray    icon in the system tray: click to toggle click-through,\n"
                "          right-click for the menu\n");
    fflush(stdout);
    return G_SOURCE_REMOVE;
}

G_GNUC_END_IGNORE_DEPRECATIONS

/* ----------------------------------------------------------------- dragging */

/**
 * Runs before WebKit's own handler (button-press-event is RUN_LAST), so the
 * press is recorded on the way past without being consumed. When the page's
 * mousedown listener posts "drag" a moment later, these are the coordinates it
 * means.
 */
static gboolean on_button_press(GtkWidget *w, GdkEventButton *e, gpointer data)
{
    (void)w;
    Overlay *o = data;

    if (e->button == GDK_BUTTON_SECONDARY) {
        popup_menu(o, (GdkEvent *)e);
        return TRUE; /* ours, not the page's */
    }

    o->drag_x_root = (gint)e->x_root;
    o->drag_y_root = (gint)e->y_root;
    gtk_window_get_position(o->window, &o->drag_win_x, &o->drag_win_y);
    return FALSE;
}

/**
 * Move the window with the pointer until the button comes up.
 *
 * The macOS target does the same thing with a local event monitor, and for the
 * same reason it does not just ask the window manager: gtk_window_begin_move_drag
 * (_NET_WM_MOVERESIZE) is a request, and Mutter declines it for this window —
 * verified on GNOME 49/Ubuntu 25.10, with the message arriving and carrying
 * valid coordinates, and the window not moving. Doing the arithmetic here works
 * on any WM and keeps accept-focus off, which asking the WM would not.
 *
 * The button press gives the web view an implicit pointer grab, so the motion
 * and release arrive here even once the pointer leaves the window.
 */
static gboolean on_motion(GtkWidget *w, GdkEventMotion *e, gpointer data)
{
    (void)w;
    Overlay *o = data;
    if (!o->dragging) return FALSE;
    gtk_window_move(o->window,
                    o->drag_win_x + ((gint)e->x_root - o->drag_x_root),
                    o->drag_win_y + ((gint)e->y_root - o->drag_y_root));
    return TRUE;
}

static gboolean on_button_release(GtkWidget *w, GdkEventButton *e, gpointer data)
{
    (void)w; (void)e;
    ((Overlay *)data)->dragging = FALSE;
    return FALSE;
}

/** WebKit ships its own context menu (Reload, Inspect…); the right-click is
 *  spent on ours instead. */
static gboolean on_context_menu(WebKitWebView *v, WebKitContextMenu *m,
                                GdkEvent *e, WebKitHitTestResult *hit, gpointer d)
{
    (void)v; (void)m; (void)e; (void)hit; (void)d;
    return TRUE; /* suppress */
}

/** The page says a left press landed on non-interactive content: from here to
 *  the button release, the window follows the pointer (see on_motion). */
static void on_drag_message(WebKitUserContentManager *m,
                            gpointer result, gpointer data)
{
    (void)m; (void)result;
    ((Overlay *)data)->dragging = TRUE;
}

/* ------------------------------------------------------------------ signals */

static gboolean handle_sigusr1(gpointer data)
{
    toggle_click_through(data);
    return G_SOURCE_CONTINUE;
}

/* -------------------------------------------------------------------- setup */

static void usage(void)
{
    g_print(
        "guildrun-overlay — Niklas' Belly, floating over the game\n"
        "\n"
        "  --port <n>       companion port (default %d)\n"
        "  --url <url>      full URL instead of the default /belly?overlay=1\n"
        "  --width <px>     panel width  (default 380)\n"
        "  --height <px>    panel height (default 520)\n"
        "  --opacity <0-1>  panel opacity (default 1.0)\n"
        "  --click-through  start with pointer input off\n"
        "\n"
        "Needs the companion running. Right-click the overlay for the menu;\n"
        "`kill -USR1 <pid>` toggles click-through when the menu is unreachable.\n",
        DEFAULT_PORT);
}

/** argv lookup in the same shape as the macOS target's Options.parse. */
static const char *arg_value(int argc, char **argv, const char *name)
{
    char flag[64];
    g_snprintf(flag, sizeof flag, "--%s", name);
    for (int i = 1; i < argc - 1; i++)
        if (g_strcmp0(argv[i], flag) == 0) return argv[i + 1];
    return NULL;
}

static gboolean has_flag(int argc, char **argv, const char *name)
{
    char flag[64];
    g_snprintf(flag, sizeof flag, "--%s", name);
    for (int i = 1; i < argc; i++)
        if (g_strcmp0(argv[i], flag) == 0) return TRUE;
    return FALSE;
}

int main(int argc, char **argv)
{
    if (has_flag(argc, argv, "help")) { usage(); return 0; }

    /*
     * Before gtk_init, and the whole reason this works under GNOME: GDK would
     * otherwise pick the Wayland backend, where keep-above and placement are
     * not requestable. Not overwritten, so GDK_BACKEND=wayland from the
     * environment still wins for anyone on a compositor where that is better.
     */
    g_setenv("GDK_BACKEND", "x11", FALSE);
    gtk_init(&argc, &argv);

    Overlay *o = g_new0(Overlay, 1);
    g_overlay = o;

    const char *url_arg = arg_value(argc, argv, "url");
    const char *port_arg = arg_value(argc, argv, "port");
    o->url = url_arg ? g_strdup(url_arg)
                     : g_strdup_printf("http://127.0.0.1:%d/belly?overlay=1",
                                       port_arg ? atoi(port_arg) : DEFAULT_PORT);

    int width = 380, height = 520, x = -1, y = -1;
    const char *w_arg = arg_value(argc, argv, "width");
    const char *h_arg = arg_value(argc, argv, "height");
    const char *o_arg = arg_value(argc, argv, "opacity");
    if (w_arg) width = atoi(w_arg);
    if (h_arg) height = atoi(h_arg);
    double opacity = o_arg ? CLAMP(g_ascii_strtod(o_arg, NULL), 0.2, 1.0) : 1.0;
    o->opacity_percent = (int)(opacity * 100 + 0.5);
    o->click_through = has_flag(argc, argv, "click-through");

    char *dir = config_dir();
    o->geometry_path = g_build_filename(dir, "overlay-linux.geometry", NULL);
    g_free(dir);
    /* an explicit --width/--height on the command line beats the saved one */
    if (!w_arg && !h_arg) geometry_load(o, &x, &y, &width, &height);
    else { int dw, dh; geometry_load(o, &x, &y, &dw, &dh); }

    /* ---- the window: borderless, transparent, above everything, focusless */

    GtkWidget *win = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    o->window = GTK_WINDOW(win);
    gtk_window_set_title(o->window, "Niklas' Belly");
    gtk_window_set_default_size(o->window, width, height);
    gtk_window_set_decorated(o->window, FALSE);
    gtk_window_set_keep_above(o->window, TRUE);      /* _NET_WM_STATE_ABOVE */
    gtk_window_stick(o->window);                     /* _NET_WM_STATE_STICKY */
    gtk_window_set_skip_taskbar_hint(o->window, TRUE);
    gtk_window_set_skip_pager_hint(o->window, TRUE);
    gtk_window_set_accept_focus(o->window, FALSE);   /* never steals the game's input */
    gtk_window_set_focus_on_map(o->window, FALSE);
    gtk_window_set_type_hint(o->window, GDK_WINDOW_TYPE_HINT_UTILITY);
    gtk_widget_set_app_paintable(win, TRUE);
    gtk_widget_set_opacity(win, opacity);

    /* an RGBA visual is what makes "transparent" mean the game, not black */
    GdkScreen *screen = gtk_widget_get_screen(win);
    GdkVisual *rgba = gdk_screen_get_rgba_visual(screen);
    if (rgba) gtk_widget_set_visual(win, rgba);

    /* ---- the web view: the companion's own page, drawn on nothing */

    WebKitUserContentManager *ucm = webkit_user_content_manager_new();
    /* connect before registering, or the first messages can race the handler */
    g_signal_connect(ucm, "script-message-received::drag",
                     G_CALLBACK(on_drag_message), o);
    webkit_user_content_manager_register_script_message_handler(ucm, "drag");
    webkit_user_content_manager_add_script(
        ucm, webkit_user_script_new(DRAG_SCRIPT,
                                    WEBKIT_USER_CONTENT_INJECT_TOP_FRAME,
                                    WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_END,
                                    NULL, NULL));

    o->view = WEBKIT_WEB_VIEW(webkit_web_view_new_with_user_content_manager(ucm));
    GdkRGBA transparent = { 0, 0, 0, 0 };
    webkit_web_view_set_background_color(o->view, &transparent);

    /*
     * No accelerated compositing: this page is static text that changes a few
     * times a minute, so a GL context and a compositor thread would buy it
     * nothing and cost a permanently resident GPU allocation. The companion's
     * resource contract (see its README) is the reason to care.
     *
     * Note this does NOT fix transparent-background repaint — see the
     * "livenecting" note in apps/overlay-linux/README.md. That one is the
     * page's to avoid.
     */
    webkit_settings_set_hardware_acceleration_policy(
        webkit_web_view_get_settings(o->view),
        WEBKIT_HARDWARE_ACCELERATION_POLICY_NEVER);
    g_signal_connect(o->view, "load-failed", G_CALLBACK(on_load_failed), o);
    g_signal_connect(o->view, "context-menu", G_CALLBACK(on_context_menu), o);

    gtk_widget_add_events(GTK_WIDGET(o->view), GDK_BUTTON_PRESS_MASK |
                          GDK_BUTTON_RELEASE_MASK | GDK_POINTER_MOTION_MASK |
                          GDK_BUTTON1_MOTION_MASK);
    g_signal_connect(o->view, "button-press-event", G_CALLBACK(on_button_press), o);
    g_signal_connect(o->view, "motion-notify-event", G_CALLBACK(on_motion), o);
    g_signal_connect(o->view, "button-release-event", G_CALLBACK(on_button_release), o);

    gtk_container_add(GTK_CONTAINER(win), GTK_WIDGET(o->view));
    g_signal_connect(win, "destroy", G_CALLBACK(gtk_main_quit), NULL);
    g_signal_connect(win, "configure-event", G_CALLBACK(on_configure), o);
    g_signal_connect(win, "draw", G_CALLBACK(on_draw), o);

    gtk_widget_show_all(win);

    /* placement after realize: top-right, or wherever it was left */
    if (x >= 0 && y >= 0) {
        gtk_window_move(o->window, x, y);
    } else {
        GdkRectangle area;
        GdkMonitor *mon = gdk_display_get_primary_monitor(gdk_display_get_default());
        if (mon) {
            gdk_monitor_get_workarea(mon, &area);
            gtk_window_move(o->window, area.x + area.width - width - 24, area.y + 24);
        }
    }
    if (o->click_through) apply_click_through(o, FALSE);

    webkit_web_view_load_uri(o->view, o->url);

    tray_init(o);
    g_timeout_add_seconds(2, tray_check, o);
    g_unix_signal_add(SIGUSR1, handle_sigusr1, o);

    /* The macOS target prints its window level for the same reason: the two
     * properties this whole thing exists for are invisible when they silently
     * fail, and both are one wrong backend away from being ignored. */
    gboolean on_x11 = GDK_IS_X11_DISPLAY(gdk_display_get_default());
    g_print("Guildrun Overlay (Linux)\n"
            "  url     %s\n"
            "  backend %s%s\n"
            "  above   %s   sticky, focusless, %s\n"
            "  pid     %d   (kill -USR1 %d toggles click-through)\n"
            "  menu    right-click the overlay, or the tray icon\n",
            o->url,
            on_x11 ? "x11" : "NOT X11",
            on_x11 ? "" : "  <- keep-above will be ignored; see README",
            on_x11 ? "yes" : "no",
            o->click_through ? "click-through ON" : "click-through off",
            (int)getpid(), (int)getpid());
    fflush(stdout);

    if (!on_x11)
        g_printerr("guildrun-overlay: not on X11 — Wayland gives clients no way to\n"
                   "  stay on top. Unset GDK_BACKEND to let this pick x11 itself.\n");

    gtk_main();

    if (o->geometry_source) g_source_remove(o->geometry_source);
    geometry_save(o);
    return 0;
}

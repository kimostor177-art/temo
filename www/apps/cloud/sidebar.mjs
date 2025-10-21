/** @type {import('types').Sidebar.RawSidebar[]} */
export const sidebar = [
  {
    sidebar_id: "cloud",
    title: "Cloud",
    items: [
      {
        type: "category",
        title: "Getting Started",
        initialOpen: true,
        children: [
          {
            type: "link",
            path: "/",
            title: "Introduction",
          },
          {
            type: "link",
            path: "/sign-up",
            title: "Sign Up",
          },
          {
            type: "link",
            path: "/faq",
            title: "FAQ",
          },
          {
            type: "link",
            path: "/comparison",
            title: "Cloud vs Self Hosting",
          },
        ],
      },
      {
        type: "category",
        title: "Basics",
        initialOpen: true,
        children: [
          {
            type: "link",
            title: "Organizations",
            path: "/organizations",
          },
          {
            type: "link",
            title: "Projects",
            path: "/projects",
          },
          {
            type: "link",
            title: "Environments",
            path: "/environments",
            children: [
              {
                type: "link",
                title: "Long-Lived",
                path: "/environments/long-lived",
              },
              {
                type: "link",
                title: "Preview",
                path: "/environments/preview",
              },
              {
                type: "link",
                title: "Environment Variables",
                path: "/environments/environment-variables",
              },
            ],
          },
          {
            type: "link",
            title: "Deployments",
            path: "/deployments",
            children: [
              {
                type: "link",
                title: "Troubleshooting",
                path: "/deployments/troubleshooting",
              },
            ],
          },
        ],
      },
      {
        type: "category",
        title: "Resources",
        initialOpen: true,
        children: [
          {
            type: "link",
            title: "Database",
            path: "/database",
          },
          {
            type: "link",
            title: "Redis",
            path: "/redis",
          },
          {
            type: "link",
            title: "S3",
            path: "/s3",
          },
          {
            type: "link",
            title: "Cache",
            path: "/cache",
          },
        ],
      },
      {
        type: "category",
        title: "Plugins",
        initialOpen: true,
        children: [
          {
            type: "link",
            title: "Loyalty",
            path: "/loyalty-plugin",
          },
          {
            type: "link",
            title: "Draft Orders",
            path: "https://docs.medusajs.com/resources/commerce-modules/order/draft-orders",
            badge: {
              text: "Published",
              variant: "blue",
            },
          },
        ],
      },
      {
        type: "category",
        title: "Billing",
        initialOpen: true,
        children: [
          {
            type: "link",
            title: "Overview",
            path: "/billing",
          },
          {
            type: "link",
            title: "Plans & Pricing",
            path: "/pricing",
          },
          {
            type: "link",
            title: "Manage Plans",
            path: "/billing/plans",
          },
          {
            type: "link",
            title: "Manage Billing Details",
            path: "/billing/manage",
          },
        ],
      },
      {
        type: "category",
        title: "Monitoring",
        initialOpen: true,
        children: [
          {
            type: "link",
            title: "Logs",
            path: "/logs",
          },
          {
            type: "link",
            title: "Notifications",
            path: "/notifications",
          },
          {
            type: "link",
            title: "Usage",
            path: "/usage",
          },
        ],
      },
      {
        type: "category",
        title: "Best Practices",
        initialOpen: true,
        children: [
          {
            type: "link",
            title: "Update Medusa",
            path: "/update-medusa",
          },
          {
            type: "link",
            title: "Connect Storefront",
            path: "/connect-storefront",
          },
        ],
      },
    ],
  },
]
